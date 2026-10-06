"""Packet-scoped read tools for the Changyi Jiuan maintenance Agent.

There is deliberately no filesystem, shell, SQL, MCP, or network method here.
"""

from __future__ import annotations

import json
from typing import Any
from jsonschema import Draft7Validator

from ms_agent.llm.utils import Tool
from ms_agent.tools.base import ToolBase

_ACTIVE_PACKET: dict[str, Any] = {}
_SUBMITTED_PLAN: dict[str, Any] | None = None
_TERMINAL_ERROR: str | None = None
_TOOL_CALLS = 0
_PLAN_SCHEMA: dict[str, Any] = {"type": "object"}


def _plan_issues(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """Return bounded schema locations, never proposal text or validator messages."""
    issues: list[dict[str, Any]] = []
    for error in Draft7Validator(_PLAN_SCHEMA).iter_errors(plan):
        prefix: list[Any] = []
        errors = [error]
        path = list(error.absolute_path)
        # For an operation union, describe the selected operation's fields;
        # the other variants' required fields are irrelevant to the repair.
        if error.validator == "oneOf" and len(path) == 2 and path[0] == "operations" and isinstance(error.instance, dict):
            variants = _PLAN_SCHEMA.get("properties", {}).get("operations", {}).get("items", {}).get("oneOf", [])
            selected = next((variant for variant in variants if variant.get("properties", {}).get("op", {}).get("const") == error.instance.get("op")), None)
            if selected is not None:
                errors = list(Draft7Validator(selected).iter_errors(error.instance))
                prefix = path
        for item in errors:
            issue: dict[str, Any] = {"path": prefix + list(item.absolute_path), "constraint": item.validator}
            if item.validator == "required" and isinstance(item.instance, dict):
                issue["missing_fields"] = [key for key in item.validator_value if key not in item.instance]
            issues.append(issue)
            if len(issues) >= 8:
                return issues
    return issues


def set_active_packet(packet: dict[str, Any], *, plan_schema: dict[str, Any] | None = None) -> None:
    global _ACTIVE_PACKET, _SUBMITTED_PLAN, _TERMINAL_ERROR, _TOOL_CALLS, _PLAN_SCHEMA
    _ACTIVE_PACKET = packet
    _SUBMITTED_PLAN = None
    _TERMINAL_ERROR = None
    _TOOL_CALLS = 0
    _PLAN_SCHEMA = plan_schema if plan_schema is not None else {"type": "object"}


def _guard() -> None:
    global _TOOL_CALLS
    _TOOL_CALLS += 1
    limit = int(_ACTIVE_PACKET.get("budget", {}).get("max_tool_calls", 4))
    if _TOOL_CALLS > limit:
        raise RuntimeError("maintenance tool-call budget exhausted")


def submitted_plan() -> dict[str, Any] | None:
    return _SUBMITTED_PLAN


def terminal_error() -> str | None:
    return _TERMINAL_ERROR


class CyjMaintenanceTool(ToolBase):
    def __init__(self, config):
        super().__init__(config)

    async def connect(self):
        return None

    async def cleanup(self):
        return None

    async def _get_tools_inner(self):
        no_args = {"type": "object", "properties": {}, "additionalProperties": False}
        return {"cyj_maintenance": [
            Tool(tool_name="read_change_packet", server_name="cyj_maintenance", description="Read the bounded change packet supplied by the deterministic harness.", parameters=no_args),
            Tool(tool_name="read_document_blocks", server_name="cyj_maintenance", description="Read only the routed document blocks embedded in this bounded packet.", parameters={"type": "object", "properties": {"section_refs": {"type": "array", "items": {"type": "string"}, "maxItems": 6}}, "required": ["section_refs"], "additionalProperties": False}),
            Tool(tool_name="read_evidence", server_name="cyj_maintenance", description="Read one evidence item already present in this packet by evidence_id.", parameters={"type": "object", "properties": {"evidence_id": {"type": "string"}}, "required": ["evidence_id"], "additionalProperties": False}),
            Tool(tool_name="read_topology_neighborhood", server_name="cyj_maintenance", description="Read the packet-routed section and conflict neighborhood; never traverses the full library.", parameters=no_args),
            Tool(tool_name="search_maintenance_evidence", server_name="cyj_maintenance", description="Search only evidence already selected into this ChangePacket.", parameters={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"], "additionalProperties": False}),
            Tool(tool_name="find_open_conflicts", server_name="cyj_maintenance", description="List conflict references already routed into this packet.", parameters=no_args),
            Tool(tool_name="submit_maintenance_plan", server_name="cyj_maintenance", description="Submit the final argon-memory-maintenance-plan/v1 object using the complete typed schema. Every patch must include its exact expected_revision, previous_block_hash, replacement_markdown, evidence_refs and reason. This records a proposal only and performs no write.", parameters={"type": "object", "properties": {"plan": _PLAN_SCHEMA}, "required": ["plan"], "additionalProperties": False}),
            Tool(tool_name="finish_no_change", server_name="cyj_maintenance", description="Return a no-change plan when no durable knowledge update is supported.", parameters={"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"], "additionalProperties": False}),
            Tool(tool_name="report_insufficient_evidence", server_name="cyj_maintenance", description="Report that the packet must be quarantined for insufficient evidence.", parameters={"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"], "additionalProperties": False}),
        ]}

    async def call_tool(self, server_name: str, *, tool_name: str, tool_args: dict) -> str:
        if server_name != "cyj_maintenance":
            return json.dumps({"error": "unknown_server"})
        handlers = {
            "read_change_packet": self.read_change_packet,
            "read_document_blocks": self.read_document_blocks,
            "read_evidence": self.read_evidence,
            "read_topology_neighborhood": self.read_topology_neighborhood,
            "search_maintenance_evidence": self.search_maintenance_evidence,
            "find_open_conflicts": self.find_open_conflicts,
            "submit_maintenance_plan": self.submit_maintenance_plan,
            "finish_no_change": self.finish_no_change,
            "report_insufficient_evidence": self.report_insufficient_evidence,
        }
        handler = handlers.get(tool_name)
        if handler is None:
            return json.dumps({"error": "unknown_tool"})
        return await handler(**tool_args)

    async def read_change_packet(self) -> str:
        _guard()
        return json.dumps({key: value for key, value in _ACTIVE_PACKET.items() if key != "media"}, ensure_ascii=False)

    async def read_evidence(self, evidence_id: str) -> str:
        _guard()
        if evidence_id not in _ACTIVE_PACKET.get("evidence_refs", []):
            return json.dumps({"error": "evidence_not_in_packet"})
        media = next((item for item in _ACTIVE_PACKET.get("media", []) if item.get("evidence_id") == evidence_id), None)
        return json.dumps({"evidence_id": evidence_id, "media": media}, ensure_ascii=False)

    async def read_document_blocks(self, section_refs: list[str]) -> str:
        _guard()
        allowed = set(_ACTIVE_PACKET.get("candidate_section_refs", []))
        if any(ref not in allowed for ref in section_refs):
            return json.dumps({"error": "section_not_in_packet"})
        return json.dumps({"section_refs": section_refs, "text_context": _ACTIVE_PACKET.get("text_context", "")}, ensure_ascii=False)

    async def read_topology_neighborhood(self) -> str:
        _guard()
        return json.dumps({"sections": _ACTIVE_PACKET.get("candidate_section_refs", []), "conflicts": _ACTIVE_PACKET.get("open_conflict_refs", [])}, ensure_ascii=False)

    async def search_maintenance_evidence(self, query: str) -> str:
        _guard()
        return json.dumps({"query": query, "evidence_refs": _ACTIVE_PACKET.get("evidence_refs", []), "text_context": _ACTIVE_PACKET.get("text_context", "")}, ensure_ascii=False)

    async def find_open_conflicts(self) -> str:
        _guard()
        return json.dumps(_ACTIVE_PACKET.get("open_conflict_refs", []), ensure_ascii=False)

    async def submit_maintenance_plan(self, plan: dict[str, Any]) -> str:
        _guard()
        issues = _plan_issues(plan)
        if issues:
            return json.dumps({"accepted_as_proposal": False, "error": "maintenance_plan_schema_invalid", "issues": issues,
                               "next_action": "Correct the listed fields using exact packet metadata and submit again; do not invent evidence or revisions."})
        global _SUBMITTED_PLAN
        _SUBMITTED_PLAN = plan
        return json.dumps({"accepted_as_proposal": True, "commit_performed": False})

    async def finish_no_change(self, reason: str) -> str:
        _guard()
        global _SUBMITTED_PLAN
        _SUBMITTED_PLAN = {
            "schema": "argon-memory-maintenance-plan/v1", "packet_id": _ACTIVE_PACKET["packet_id"],
            "base_knowledge_revision": _ACTIVE_PACKET["base_revisions"]["knowledge_revision"],
            "expected_topology_revision": _ACTIVE_PACKET["base_revisions"]["topology_revision"],
            "prompt_version": "argon-memory-maintenance/0.5.0", "tool_schema_version": "argon-memory-maintenance-tools/0.5.0",
            "operations": [{"op": "no_change", "reason": reason}],
            "native_video_evidence_ids": [
                item["evidence_id"] for item in _ACTIVE_PACKET.get("media", [])
                if item.get("modality") == "video" and item.get("native_video_required")
            ],
        }
        return json.dumps({"accepted_as_proposal": True, "commit_performed": False})

    async def report_insufficient_evidence(self, reason: str) -> str:
        _guard()
        global _TERMINAL_ERROR
        _TERMINAL_ERROR = reason
        return json.dumps({"quarantine_required": True, "reason": reason})
