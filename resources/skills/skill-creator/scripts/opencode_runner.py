"""Isolated, maintenance-only OpenCode execution. No Claude CLI or extra SDK required."""

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


class OpenCodeExecutionError(RuntimeError):
    """A runtime failure must never count as a successful negative trigger test."""


def parse_events(output: str) -> list[dict]:
    events = []
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue  # CLI startup notices are not model output.
        if isinstance(event, dict):
            events.append(event)
    if any(event.get("type") == "error" for event in events):
        raise OpenCodeExecutionError("OpenCode reported an error; inspect the local runtime log")
    if any(event.get("type") == "tool_use" and event.get("part", {}).get("state", {}).get("status") != "completed"
           for event in events):
        raise OpenCodeExecutionError("OpenCode tool did not complete successfully")
    if not any(
        event.get("type") == "step_finish" and event.get("part", {}).get("reason") == "stop"
        for event in events
    ):
        raise OpenCodeExecutionError("OpenCode did not complete a response")
    return events


def skill_triggered(events: list[dict], name: str) -> bool:
    return any(
        event.get("type") == "tool_use"
        and event.get("part", {}).get("tool") == "skill"
        and event["part"].get("state", {}).get("status") == "completed"
        and event["part"]["state"].get("input", {}).get("name") == name
        for event in events
    )


def run_opencode(
    prompt: str,
    model: str | None = None,
    timeout: int = 60,
    skill_name: str | None = None,
    description: str | None = None,
) -> list[dict]:
    executable = os.environ.get("ZEN_OPENCODE_EXECUTABLE") or shutil.which("opencode")
    if not executable:
        raise OpenCodeExecutionError("Set ZEN_OPENCODE_EXECUTABLE to the bundled OpenCode executable")
    try:
        configured = json.loads(os.environ["OPENCODE_CONFIG_CONTENT"])
        selected_model = model or configured.get("model")
        if not configured.get("provider") or not selected_model:
            raise ValueError("missing provider or model")
    except (KeyError, ValueError, TypeError) as exc:
        raise OpenCodeExecutionError("Provide maintenance OPENCODE_CONFIG_CONTENT with provider and model") from exc

    with tempfile.TemporaryDirectory(prefix="zen-skill-eval-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        workspace.mkdir()
        config = {
            "$schema": "https://opencode.ai/config.json",
            "provider": configured["provider"],
            "model": selected_model,
            "small_model": selected_model,
            "enabled_providers": [selected_model.split("/", 1)[0]],
            "snapshot": False,
            "autoupdate": False,
            "share": "disabled",
            "plugin": [],
            "mcp": {},
            "lsp": False,
            "formatter": False,
            "permission": {"*": "deny", "skill": "allow"},
            "agent": {"title": {"disable": True}, "eval": {
                "mode": "primary",
                "prompt": "Answer the user's request. Consult a relevant available skill when useful.",
                "tools": {"*": False, "skill": True},
            }},
            "skills": {"paths": [], "urls": []},
        }
        if skill_name is not None:
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", skill_name):
                raise ValueError("Skill name must use lowercase letters, numbers and hyphens")
            # Isolate each candidate; never mutate the user's skill or workspace.
            candidate = root / "skills" / skill_name
            candidate.mkdir(parents=True)
            (candidate / "SKILL.md").write_text(
                f"---\nname: {json.dumps(skill_name)}\ndescription: {json.dumps(description, ensure_ascii=False)}\n"
                "---\n\nThis is a trigger evaluation. Give a brief response after consulting this skill.\n",
                encoding="utf-8",
            )
            config["skills"]["paths"] = [str(root / "skills")]

        env = dict(os.environ)
        for key in list(env):
            if key.startswith("OPENCODE_") or key in ("CLAUDECODE", "NODE_OPTIONS", "BUN_OPTIONS"):
                del env[key]
        env.update({
            "HOME": str(root / "home"), "USERPROFILE": str(root / "home"),
            "XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data"),
            "XDG_CACHE_HOME": str(root / "cache"), "XDG_STATE_HOME": str(root / "state"),
            "OPENCODE_CONFIG_CONTENT": json.dumps(config), "OPENCODE_PURE": "true",
            "OPENCODE_DISABLE_PROJECT_CONFIG": "true", "OPENCODE_DISABLE_AUTOUPDATE": "true",
            "OPENCODE_DISABLE_MODELS_FETCH": "true", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
            "OPENCODE_DISABLE_EXTERNAL_SKILLS": "true", "OPENCODE_DISABLE_CLAUDE_CODE": "true",
            "OPENCODE_DISABLE_LSP_DOWNLOAD": "true", "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER": "true",
            "npm_config_offline": "true", "npm_config_audit": "false", "npm_config_fund": "false",
        })
        # Reuse the app's prepared dependency directory, not its workspace/config.
        dependencies = os.environ.get("ZEN_OPENCODE_DEPENDENCIES")
        if dependencies:
            config_dir = root / "config" / "opencode"
            config_dir.mkdir(parents=True)
            for name in ("package.json", "package-lock.json", "bun.lock", "bun.lockb"):
                source = Path(dependencies) / name
                if source.is_file():
                    shutil.copy2(source, config_dir / name)
            modules = Path(dependencies) / "node_modules"
            if os.name == "nt":
                import _winapi
                _winapi.CreateJunction(str(modules.resolve()), str(config_dir / "node_modules"))
            else:
                (config_dir / "node_modules").symlink_to(modules.resolve(), target_is_directory=True)
        process = subprocess.Popen(
            [executable, "run", "--pure", "--format", "json", "--agent", "eval"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=workspace, env=env, text=True, encoding="utf-8", errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            output, _ = process.communicate(prompt, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True,
                               creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
            process.kill()
            process.communicate()
            raise OpenCodeExecutionError(f"OpenCode timed out after {timeout}s") from exc
        if process.returncode:
            # Avoid printing provider credentials from stderr or config in reports.
            raise OpenCodeExecutionError(f"OpenCode exited with code {process.returncode}")
        return parse_events(output)


def call_text(prompt: str, model: str | None, timeout: int = 120) -> str:
    events = run_opencode(prompt, model, timeout)
    text = "".join(event.get("part", {}).get("text", "") for event in events if event.get("type") == "text")
    if not text.strip():
        raise OpenCodeExecutionError("OpenCode returned no text")
    return text
