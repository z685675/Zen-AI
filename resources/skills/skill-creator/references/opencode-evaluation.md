# OpenCode maintenance evaluation

This workflow is for maintainers. Model-backed runs use the explicitly selected provider and can incur API usage. Do not run the optimization loop merely because this skill was loaded.

Run modules from the skill directory in an authorized maintenance Python environment (Python 3.11+). Set:

- `ZEN_OPENCODE_EXECUTABLE`: absolute path to the bundled OpenCode executable (or have opencode on PATH).
- `OPENCODE_CONFIG_CONTENT`: native OpenCode JSON containing provider definitions and a model in provider/model form. Supply it locally without logging credentials. The managed Python tool does not inherit the app's private runtime configuration.
- `ZEN_OPENCODE_DEPENDENCIES`: absolute path to the app's prepared opencode-runtime folder, containing package.json and node_modules, for offline startup. The runner copies package metadata and links the dependency directory without downloading plugins.

```text
python -m scripts.run_eval --eval-set evals/trigger-eval.json --skill-path /absolute/skill --num-workers 1 --runs-per-query 1 --timeout 60
python -m scripts.run_loop --eval-set evals/trigger-eval.json --skill-path /absolute/skill --model provider/model --max-iterations 3 --report none
```

The eval set is an array of objects containing a unique query string and a boolean should_trigger. Include realistic positive cases and near-miss negatives. Each run uses a new temporary workspace and only the candidate's name/description, so it measures selection, not execution quality. Other tools, external skills, project config, MCP servers and plugins are disabled. The installed skill and user's project stay unchanged.

OpenCode JSON events must show a completed native skill tool with the exact candidate name to count as triggered, and a completed response to count as a valid run. A timeout, provider failure, malformed/unfinished response or failed tool is an error, never a passing negative case. Read summary.errors and per-query errors. The evaluation CLI exits nonzero on failed or invalid evaluation. The optimization loop refuses to improve from runtime errors. Defaults use one worker and one run; increase repeats only when necessary.

A successful description evaluation says nothing about output quality. Check actual files and compare the old/new skill on the same model separately. Keep the source skill unchanged until the candidate description and behavioral results have been reviewed. No benchmark or optimizer runs automatically in the application.
