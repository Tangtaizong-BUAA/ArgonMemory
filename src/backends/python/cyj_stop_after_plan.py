"""Stop MS-Agent immediately after a maintenance terminal tool succeeds."""

from pathlib import Path
import sys

from ms_agent.callbacks.base import Callback

TOOLS = Path(__file__).with_name("tools")
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from cyj_maintenance import submitted_plan, terminal_error


class CyjStopAfterPlan(Callback):
    async def after_tool_call(self, runtime, messages):
        if submitted_plan() is not None or terminal_error() is not None:
            runtime.should_stop = True
