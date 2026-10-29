"""Run through the RstrBot host; this example has no network or file operations."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rstrbot_sdk import Plugin, RpcFailure, serve


async def handle(method, params, call):
    if method == "tools.list":
        return {"tools": [{"name": "echo", "effect": "read_only", "input_schema": {
            "type": "object", "properties": {"text": {"type": "string", "maxLength": 16384}},
            "required": ["text"], "additionalProperties": False}}]}
    if method != "tools.call" or params.get("name") != "echo":
        raise RpcFailure(-32601, "Method not found")
    text = params.get("arguments", {}).get("text")
    if not isinstance(text, str) or len(text.encode()) > 16384:
        raise RpcFailure(-32602, "Invalid text")
    await call.emit("tool.progress", {"stage": "received"})
    return {"content": text, "effect": "read_only", "call_id": params.get("call_id")}


plugin = Plugin(("tools",), handle)
if __name__ == "__main__":
    asyncio.run(serve(plugin))
