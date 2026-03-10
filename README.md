# /human-experience

**Vision-powered UX simulation engine for Claude Code.**

Opens UIs in a real browser, takes screenshots at multiple viewports, clicks through interactive elements, records video, maps CTA funnels, tests signup flows, and analyzes everything through Claude's vision capabilities combined with empirical UX research baselines.

## What It Does

- Renders pages in Chromium via Playwright (not guessing from code)
- Captures desktop, tablet, and mobile viewports
- Tests hover states, click interactions, form fields, error states
- Maps every CTA to its destination with screenshots
- Tests signup flows with disposable email inboxes (AgentMail)
- Scores across 7 UX dimensions (First Impression, Navigation, Emotional Arc, Trust, Time to Value, Responsive Quality, Interactive Quality)
- Generates HTML reports with inline screenshot evidence
- Karpathy-style ratchet loop for iterative perfection (--loop)

## Installation

```bash
# Clone into your Claude Code skills directory
git clone https://github.com/andrew-shwetzer/human-experience.git ~/.claude/skills/human-experience

# Install Playwright
cd ~/.claude/skills/human-experience
npm install
npx playwright install chromium
```

## Usage

In Claude Code:
```
/human-experience https://example.com
/human-experience ./index.html --loop
/human-experience https://example.com --mode speed
/human-experience https://example.com --mode qa
/human-experience https://example.com --redesign
/human-experience https://example.com --persona "first-time visitor"
```

### Capture Script (Standalone)

The Playwright capture engine can also be run directly:

```bash
node capture.mjs "https://example.com" --output-dir /tmp/hx-session --all
```

Flags:
- `--all` : Full capture (screenshots, hover states, interactions, forms, errors, funnel)
- `--video` : Record interaction video
- `--scroll` : Scroll-depth captures
- `--dark-mode` : Dark mode variant
- `--funnel` : Map all CTAs to their destinations
- `--signup --agentmail-key <key>` : Test signup with disposable inbox
- `--flow '<json>'` : Scripted multi-page journey
- `--wait-until domcontentloaded|networkidle|load` : Page load strategy

## Files

| File | Purpose |
|------|---------|
| `skill.md` | Claude Code skill prompt (the brain) |
| `capture.mjs` | Playwright capture engine (the eyes) |
| `ux-research.md` | Empirical UX research baselines (the standards) |
| `package.json` | Node dependencies |

## Modes

| Mode | What it does |
|------|-------------|
| (default) | Full 7-step simulation with HTML report |
| `--mode speed` | Friction inventory + fixes only (no narrative) |
| `--mode onboard` | Simulate brand-new user, track time-to-value |
| `--mode compare` | Side-by-side comparison of two versions |
| `--mode qa` | Structured checklist (functional, visual, responsive, a11y) |
| `--loop` | Iterate fixes until all dimensions hit 5/5 |
| `--redesign` | Generate an HTML mockup implementing top fixes |

## Dimension Scorecard

Each simulation produces a 7-dimension score (1-5 each, 35 max):

```
First Impression     [1-5]  Visual quality, hierarchy, 50ms test
Navigation & Flow    [1-5]  Can user complete the journey
Emotional Arc        [1-5]  Confidence stays high, no valleys
Trust & Polish       [1-5]  Feels professional, no broken states
Time to Value        [1-5]  User gets value fast
Responsive Quality   [1-5]  Works across viewports
Interactive Quality  [1-5]  State changes, feedback, hover/click
```

## Sample Output

See the `examples/` directory for a sample UX report.

## Requirements

- [Claude Code](https://claude.ai/claude-code) (to use as a skill)
- Node.js 18+
- Playwright (installed via npm)

The capture script works standalone. The skill prompt requires Claude Code.

## License

MIT
