"""Databricks Genie Conversation API client.

Sends a question to the configured Genie Space (``genie_space_id`` /
``GENIE_SPACE_ID``) and returns the answer text plus, for query answers, a
compact result table fetched from the query-result endpoint.

Conversation flow:
  1. POST /api/2.0/genie/spaces/{space_id}/start-conversation
  2. Poll GET  .../conversations/{conv_id}/messages/{msg_id} until COMPLETED.
  3. Extract text + query-result attachments from the completed message.
"""
from __future__ import annotations

import json
import logging
import os
import ssl
import time
import urllib.error
import urllib.request

from data.config import get_settings

logger = logging.getLogger(__name__)

_POLL_INTERVAL = 1.5
# Genie generates SQL, runs it (account-wide billing scans can take 30-60s on
# their own) and narrates — give the whole answer a generous budget. app.py
# streams SSE keepalives while this runs so the proxy doesn't drop the
# connection.
_POLL_TIMEOUT = 240.0



def _get_credentials() -> tuple[str, str]:
    host = os.environ.get("DATABRICKS_HOST", "").rstrip("/")
    if host and not host.startswith("http"):
        host = f"https://{host}"
    # On-behalf-of-user only (forwarded viewer token, scope dashboards.genie):
    # Genie answers with the VIEWER's permissions, never the app SP.
    from data.live import USER_TOKEN

    return host, USER_TOKEN.get()


def _space_id() -> str:
    return str(get_settings().get("genie_space_id") or "")



def is_available() -> bool:
    """True when a Genie space is configured and credentials exist."""
    host, token = _get_credentials()
    return bool(host and token and _space_id())


def _api(host: str, token: str, method: str, path: str, body: dict | None = None) -> dict:
    url = f"{host}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
        return json.loads(resp.read().decode())


def ask(question: str) -> str | None:
    """Send *question* to the Genie space; return the answer text or None."""
    if not is_available():
        return None
    host, token = _get_credentials()
    space_id = _space_id()
    try:
        started = _api(host, token, "POST",
                       f"/api/2.0/genie/spaces/{space_id}/start-conversation",
                       {"content": question})
        conv_id = started.get("conversation_id") or started.get("conversation", {}).get("conversation_id")
        msg_id = started.get("message_id") or started.get("message", {}).get("id")
        if not conv_id or not msg_id:
            logger.warning("Genie start-conversation missing IDs: %s", started)
            return None
        deadline = time.time() + _POLL_TIMEOUT
        while time.time() < deadline:
            time.sleep(_POLL_INTERVAL)
            msg = _api(host, token, "GET",
                       f"/api/2.0/genie/spaces/{space_id}/conversations/{conv_id}/messages/{msg_id}")
            status = msg.get("status", "")
            if status == "COMPLETED":
                return _extract_answer(host, token, space_id, conv_id, msg_id, msg)
            if status in ("FAILED", "CANCELLED"):
                logger.warning("Genie message status: %s", status)
                return None
        logger.warning("Genie query timed out after %.0fs", _POLL_TIMEOUT)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Genie API error: %s", exc)
        return None


def _extract_answer(host: str, token: str, space_id: str, conv_id: str,
                    msg_id: str, message: dict) -> str | None:
    """Assemble the answer from a COMPLETED Genie message.

    Text attachments are used verbatim. For query attachments the DATA lives in
    a separate query-result endpoint — without fetching it the "answer" is just
    Genie restating the question, so pull the rows and render a small table.
    """
    parts: list[str] = []
    for attachment in message.get("attachments", []):
        text_block = attachment.get("text", {})
        content = text_block.get("content") or text_block.get("body") or text_block.get("text")
        if content:
            parts.append(content)
            continue
        query_block = attachment.get("query", {})
        if query_block:
            description = query_block.get("description") or ""
            att_id = attachment.get("attachment_id") or attachment.get("id")
            table = _query_result_table(host, token, space_id, conv_id, msg_id, att_id) if att_id else None
            combined = "\n\n".join(p for p in (description, table) if p)
            if combined:
                parts.append(combined)
    if parts:
        return "\n\n".join(parts)
    return message.get("content") or None


def _query_result_table(host: str, token: str, space_id: str, conv_id: str,
                        msg_id: str, att_id: str, max_rows: int = 8) -> str | None:
    """Fetch a query attachment's result and render it as a compact text table.
    Best-effort: any miss returns None and the description alone is used."""
    try:
        res = _api(host, token, "GET",
                   f"/api/2.0/genie/spaces/{space_id}/conversations/{conv_id}"
                   f"/messages/{msg_id}/attachments/{att_id}/query-result")
        sr = res.get("statement_response") or {}
        cols = [c.get("name") for c in ((sr.get("manifest") or {}).get("schema") or {}).get("columns", [])]
        rows = ((sr.get("result") or {}).get("data_array") or [])[:max_rows]
        if not cols or not rows:
            return None
        # GitHub-flavored markdown table — the UI renders it via remark-gfm.
        lines = ["| " + " | ".join(str(c) for c in cols) + " |",
                 "| " + " | ".join("---" for _ in cols) + " |"]
        lines += ["| " + " | ".join("" if v is None else str(v) for v in row) + " |" for row in rows]
        return "\n".join(lines)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Genie query-result fetch failed: %s", exc)
        return None
