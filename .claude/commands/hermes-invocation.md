# Hermes CLI — Non-Interactive Invocation Pattern

выполни промт с помощью хермеса и проверь его работу

Hermes uses `prompt_toolkit` which requires a Win32 console. Non-TTY shells (bash, subprocess) crash with `NoConsoleScreenBufferError`. Solution: monkey-patch `prompt_toolkit.output.defaults.create_output` via Python wrapper.

## Working Command

```bash
PROMPT="your prompt here" && TERM=dumb NO_COLOR=1 "C:\Users\Undre\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe" -c "
import sys, os
os.environ['TERM'] = 'dumb'
os.environ['NO_COLOR'] = '1'
os.environ['PROMPT_TOOLKIT_NO_CPR'] = '1'
import prompt_toolkit.output.defaults as ptd
original_create = ptd.create_output
def patched_create(stdout=None, *a, **kw):
    try:
        return original_create(stdout, *a, **kw)
    except Exception:
        from prompt_toolkit.output.plain_text import PlainTextOutput
        return PlainTextOutput(stdout or sys.stdout)
ptd.create_output = patched_create
from hermes_cli.main import main
sys.argv = ['hermes', 'chat', '-q', '''$PROMPT''', '--verbose']
main()
" 2>&1
```

## Long Prompts

For prompts exceeding shell escaping limits, write to a temp file first:

```bash
# Write prompt to workspace (allowed directory)
cat > .hermes-prompt.txt << 'PROMPT_EOF'
Your long multi-line prompt here.
Can reference files, list tasks, etc.
PROMPT_EOF

PROMPT=$(cat .hermes-prompt.txt) && TERM=dumb NO_COLOR=1 "C:\Users\Undre\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe" -c "
import sys, os
os.environ['TERM'] = 'dumb'
os.environ['NO_COLOR'] = '1'
os.environ['PROMPT_TOOLKIT_NO_CPR'] = '1'
import prompt_toolkit.output.defaults as ptd
original_create = ptd.create_output
def patched_create(stdout=None, *a, **kw):
    try:
        return original_create(stdout, *a, **kw)
    except Exception:
        from prompt_toolkit.output.plain_text import PlainTextOutput
        return PlainTextOutput(stdout or sys.stdout)
ptd.create_output = patched_create
from hermes_cli.main import main
sys.argv = ['hermes', 'chat', '-q', '''$PROMPT''', '--verbose']
main()
" 2>&1

# Cleanup
rm -f .hermes-prompt.txt
```

## What Does NOT Work

| Method | Why it fails |
|--------|-------------|
| `Hermes chat -q "..."` | `prompt_toolkit` → `NoConsoleScreenBufferError` in non-TTY |
| `winpty Hermes chat -q "..."` | `stdin is not a tty` |
| `cmd.exe /c "Hermes chat -q ..."` | Path quoting issues with `/` in content |
| `python -m hermes_cli` | Module has no `__main__` |
| `TERM=dumb` alone | `prompt_toolkit` ignores it on Windows, requires Win32 console buffer |

## Key Points

1. **Python binary**: Always use Hermes' venv Python at `C:\Users\Undre\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe`
2. **Entry point**: `from hermes_cli.main import main` → set `sys.argv` manually → call `main()`
3. **Monkey-patch**: Replace `create_output` to fall back to `PlainTextOutput` when no console available
4. **Environment**: `TERM=dumb`, `NO_COLOR=1`, `PROMPT_TOOLKIT_NO_CPR=1` — belt and suspenders
5. **Timeout**: Use 600000ms (10 min) for complex tasks with subagents
6. **Workdir**: Always set to project root
7. **Verbose**: `--verbose` flag shows subagent progress in real-time

## Prompt Template for Code Fixes

```
Fix the following issues from code review. Spawn subagents for parallel work where possible.

TASK 1 - <ID>: <description>
- File: <path>
- What to do: <specific instructions>

TASK 2 - <ID>: <description>
- File: <path>  
- What to do: <specific instructions>

Do NOT commit.
```
