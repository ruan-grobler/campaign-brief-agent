# Publishing checklist

Nothing here is public yet. This folder is a local git repo with one commit and no remote.

## GitHub description (one line)

Claude agents turn a campaign brief into a checked cross-team launch plan, with validated MCP tools, an adversarial checker, human approval by exception and a dry-run Asana and Slack outbox. Offline demo, no API key.

## Topics

`claude`, `anthropic`, `ai-agents`, `multi-agent-systems`, `model-context-protocol`, `human-in-the-loop`, `prompt-injection`, `llm-evaluation`, `marketing-automation`, `typescript`

## Checklist for Ruan

1. **Create the repo yourself** at github.com/new: name `campaign-brief-agent`, under `ruan-grobler`. Do not add a README, license or .gitignore; the repo has them.
2. **Optional, before the first push.** The commit's author email is your configured git email. To publish with your GitHub noreply address instead, set it with `git config user.email` in this folder, then run `git commit --amend --reset-author --no-edit`.
3. **Push** from Terminal, in this folder:

   ```bash
   git remote add origin https://github.com/ruan-grobler/campaign-brief-agent.git
   git push -u origin main
   ```

4. **Enable Actions** (Settings, Actions, General) if they are off, and check that the first CI run goes green: typecheck, 38 tests, demo.
5. **Switch on the CI badge.** Uncomment the CI badge block at the top of `README.md`, commit and push.
6. **About panel.** Paste the description and the topics above.
7. **Optional live mode.** Create your own `ANTHROPIC_API_KEY` in the Claude Console, or use your logged-in Claude Code CLI. Export the key in your shell, never in a committed file, then run `npm start -- examples/brief.md --today 2026-10-19` or `npm run ui`. No Asana or Slack account is needed: the send is a dry run.

## Secret scan

gitleaks is not installed on the build machine, so a regex scanner (AWS, GitHub, Anthropic, OpenAI, Slack, Stripe, Twilio, Google, JWT, private keys, passwords in URLs, generic key assignments and more) ran over the full git history and the working tree after the commit. It never prints a matched value. Result:

```text
git repo: True, commits: 1, history blobs scanned: 80, working tree files scanned: 80
findings: 0, placeholder-looking matches: 0
```

That scanner reads the first 20,000 characters of each line, and the recorded event logs have longer lines, so the same rules were also run over every committed file in full: 0 findings.

## Personal data scan

A second regex scan looked for personal data (emails, phone numbers, ID numbers, street addresses, names and local file paths) over the full git history, the commit metadata and the working tree after the commit, and again over every committed file in full. It found none beyond the git author and committer email on the commit, which step 2 above can swap for a noreply address. The only email domain outside the synthetic example domains is `anthropic.com`, from the `Co-Authored-By` trailer.

## Notes for review

- The recorded runs in `examples/recorded-eval/` are model output and stay as recorded. One agent message in the Brewly recording uses an em dash as an empty table cell.
- The demo writes its replay logs to `runs/`, which is gitignored. Those local logs contain absolute paths of the machine that ran them, like any live run, and are never committed.
