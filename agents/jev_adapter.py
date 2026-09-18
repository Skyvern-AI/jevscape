"""
Harbor adapter for Jev (TypeSafe's System One model, `jev-latest`).

Jev is not a chat or coding model: it answers typed questions (choice / noul /
score) over a state and returns calibrated probabilities. It cannot call the
MCP `execute_code` tool or write a script, so it cannot run through the
OpenCode / claude-code / codex adapters.

This adapter uploads `agents/jev/` (a Bun controller) into the task container
at `/app/bots/jev` and runs it. The controller observes the game through
rs-sdk, builds a fixed catalog of macro-actions whose preconditions are met,
asks Jev which one to run for the next burst, executes it, and repeats until
the task clock runs out. See agents/jev/README.md for the design and the
comparability caveats.

Usage with Harbor:
    PYTHONPATH=agents harbor run \
        --agent-import-path 'jev_adapter:JevSystemOne' \
        -m 'typesafe/jev-latest' \
        -p tasks/woodcutting-xp-15m

Env: TYPESAFE_API_KEY (forwarded into the sandbox). Agent kwargs:
    --ak policy=jev|random|first   (default jev)
    --ak burst_ms=20000
"""

import json
import logging
import os
import re
import shlex
import uuid
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories.agent import Agent as ATIFAgent
from harbor.models.trajectories.final_metrics import FinalMetrics
from harbor.models.trajectories.metrics import Metrics
from harbor.models.trajectories.observation import Observation
from harbor.models.trajectories.observation_result import ObservationResult
from harbor.models.trajectories.step import Step
from harbor.models.trajectories.tool_call import ToolCall
from harbor.models.trajectories.trajectory import Trajectory

logger = logging.getLogger(__name__)

_JEV_DIR = Path(__file__).parent / "jev"
_CONTAINER_DIR = "/app/bots/jev"
_USD_PER_M_INPUT = 0.042  # published jev price; output tokens are free


class JevSystemOne(BaseInstalledAgent):
    _original_key = os.environ.get("TYPESAFE_API_KEY", "")

    def __init__(self, policy: str = "jev", burst_ms: int = 20000, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._policy = policy
        self._burst_ms = int(burst_ms)

    @staticmethod
    def name() -> str:
        return "jev-systemone"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "install-jev.sh.j2"

    async def install(self, environment: BaseEnvironment) -> None:
        # bun is pre-installed in the benchmark image; only the controller needs to go in.
        await environment.upload_dir(_JEV_DIR, _CONTAINER_DIR)
        result = await environment.exec(command=f"test -f {_CONTAINER_DIR}/run.ts && bun --version")
        if result.return_code != 0:
            raise RuntimeError(f"jev controller upload failed: {result.stdout} {result.stderr}")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        self._last_instruction = instruction
        skill, minutes = _parse_task(instruction)
        model = (self.model_name or "typesafe/jev-latest").split("/", 1)[-1]
        key = self._original_key or os.environ.get("TYPESAFE_API_KEY", "")
        if self._policy == "jev" and not key:
            raise RuntimeError("TYPESAFE_API_KEY is not set")
        env = {"TYPESAFE_API_KEY": key, "JEV_MODEL": model}
        cmd = (
            "mkdir -p /logs/agent && cd /app && "
            f"bun bots/jev/run.ts --skill {shlex.quote(skill)} --minutes {minutes} --log-dir /logs/agent "
            f"--policy {shlex.quote(self._policy)} --burst-ms {self._burst_ms} --model {shlex.quote(model)} "
            "2>&1 | tee -a /logs/agent/jev-controller.txt"
        )
        await self.exec_as_agent(environment, command=cmd, env=env, timeout_sec=minutes * 60 + 90)

    def populate_context_post_run(self, context: AgentContext) -> None:
        decisions = self.logs_dir / "decisions.jsonl"
        if not decisions.exists():
            logger.warning("jev decisions log not found: %s", decisions)
            return
        try:
            trajectory = _decisions_to_trajectory(
                decisions,
                model_name=(self.model_name or "typesafe/jev-latest"),
                agent_name=self.name(),
                instruction=getattr(self, "_last_instruction", None),
            )
        except Exception:
            logger.exception("failed to build ATIF trajectory from jev decisions")
            return
        (self.logs_dir / "trajectory.json").write_text(json.dumps(trajectory.model_dump(exclude_none=True), indent=2))
        fm = trajectory.final_metrics
        if fm:
            context.n_input_tokens = fm.total_prompt_tokens or 0
            context.n_output_tokens = fm.total_completion_tokens or 0
            context.n_cache_tokens = 0
            context.cost_usd = fm.total_cost_usd


def _parse_task(instruction: str) -> tuple[str, int]:
    m = re.search(r"Train (\w+) as efficiently as possible for (\d+) minutes", instruction)
    if not m:
        raise ValueError("could not parse skill/minutes from the task instruction")
    return m.group(1), int(m.group(2))


def _decisions_to_trajectory(path: Path, model_name: str, agent_name: str, instruction: str | None) -> Trajectory:
    steps: list[Step] = []
    step_id = 0
    if instruction:
        step_id += 1
        steps.append(Step(step_id=step_id, source="user", message=instruction))
    total_in = 0
    total_out = 0
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        call_id = str(uuid.uuid4())
        outcome = rec.get("outcome") or {}
        in_tok = int(rec.get("input_tokens") or 0)
        out_tok = int(rec.get("output_tokens") or 0)
        total_in += in_tok
        total_out += out_tok
        cost = in_tok * _USD_PER_M_INPUT / 1_000_000
        step_id += 1
        p = rec.get("probability")
        c = rec.get("confidence")
        steps.append(
            Step(
                step_id=step_id,
                timestamp=rec.get("ts"),
                source="agent",
                message=(
                    f"jev chose {rec.get('choice')} (p={p:.2f}, confidence={c:.2f}) from {len(rec.get('candidates') or [])} options"
                    if isinstance(p, (int, float)) and isinstance(c, (int, float))
                    else f"{rec.get('choice')} from {len(rec.get('candidates') or [])} options"
                ),
                tool_calls=[ToolCall(tool_call_id=call_id, function_name=str(rec.get("choice")), arguments={"candidates": rec.get("candidates")})],
                observation=Observation(results=[ObservationResult(source_call_id=call_id, content=json.dumps(outcome))]),
                metrics=Metrics(prompt_tokens=in_tok, completion_tokens=out_tok, cached_tokens=0, cost_usd=cost if cost else None),
            )
        )
    if not steps:
        steps.append(Step(step_id=1, source="system", message="No decisions recorded"))
    return Trajectory(
        schema_version="ATIF-v1.6",
        session_id=str(uuid.uuid4()),
        agent=ATIFAgent(name=agent_name, version="unknown", model_name=model_name),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=total_in,
            total_completion_tokens=total_out,
            total_cached_tokens=0,
            total_cost_usd=round(total_in * _USD_PER_M_INPUT / 1_000_000, 6) if total_in else None,
            total_steps=len(steps),
        ),
    )
