from __future__ import annotations

from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field
from typing import AsyncGenerator, NamedTuple

from ..core.protocols import ReadableFontBackend
from .actions import (
    ConnectableActionProtocol,
    InputActionProtocol,
    OutputActionProtocol,
    getActionClass,
)
from .merger import FontBackendMerger


@dataclass(kw_only=True)
class Workflow:
    config: dict
    steps: list[ActionStep] = field(init=False)

    def __post_init__(self):
        self.steps = _structureSteps(self.config["steps"])

    @asynccontextmanager
    async def endPoints(self) -> AsyncGenerator[WorkflowEndPoints, None]:
        async with AsyncExitStack() as exitStack:
            endPoints = await _prepareEndPoints(None, self.steps, exitStack)
            yield endPoints


class WorkflowEndPoints(NamedTuple):
    endPoint: ReadableFontBackend | None
    outputs: list[OutputActionProtocol]


async def _prepareEndPoints(
    currentInput: ReadableFontBackend | None,
    steps: list[ActionStep],
    exitStack: AsyncExitStack,
) -> WorkflowEndPoints:
    outputs: list[OutputActionProtocol] = []

    for step in steps:
        actionClass = getActionClass(step.name)
        action = actionClass(**step.arguments)

        if isinstance(action, OutputActionProtocol):
            # output
            assert isinstance(action, ConnectableActionProtocol)
            assert currentInput is not None

            # set up nested steps
            outputStepsResult, moreOutput = await _prepareEndPoints(
                currentInput, step.steps, exitStack
            )
            outputs.extend(moreOutput)

            assert isinstance(outputStepsResult, ReadableFontBackend)
            action = await exitStack.enter_async_context(
                action.connect(outputStepsResult)
            )
            outputs.append(action)
        elif isinstance(action, ConnectableActionProtocol):
            # filter
            assert isinstance(action, ReadableFontBackend)
            assert currentInput is not None

            action = await exitStack.enter_async_context(action.connect(currentInput))

            # set up nested steps
            action, moreOutput = await _prepareEndPoints(action, step.steps, exitStack)
            outputs.extend(moreOutput)

            currentInput = action
        elif isinstance(action, InputActionProtocol):
            # input
            action = await exitStack.enter_async_context(action.prepare())
            assert isinstance(action, ReadableFontBackend)

            # set up nested steps
            action, moreOutput = await _prepareEndPoints(action, step.steps, exitStack)
            outputs.extend(moreOutput)

            if currentInput is None:
                currentInput = action
            else:
                currentInput = FontBackendMerger(inputA=currentInput, inputB=action)
        else:
            raise AssertionError("Expected code to be unreachable")

    return WorkflowEndPoints(currentInput, outputs)


@dataclass(kw_only=True)
class ActionStep:
    name: str
    arguments: dict
    steps: list[ActionStep] = field(default_factory=list)
    action: ReadableFontBackend | ConnectableActionProtocol | OutputActionProtocol | None = field(
        init=False, default=None
    )


def _structureSteps(rawSteps):
    structured = []

    for rawStep in rawSteps:
        actionName = rawStep["action"]
        arguments = dict(rawStep)
        arguments.pop("action")
        subSteps = _structureSteps(arguments.pop("steps", []))
        structured.append(
            ActionStep(name=actionName, arguments=arguments, steps=subSteps)
        )

    return structured
