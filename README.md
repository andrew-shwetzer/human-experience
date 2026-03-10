# /human-experience

**Automated UX testing powered by Claude's vision. Point it at any URL or local file, get a full simulation of a real user walking through your UI.**

No more guessing. No more "looks good to me." This renders your page in a real browser, captures 36+ screenshots across 3 viewports, clicks every button, fills every form, maps every CTA funnel, and scores the experience across 7 empirical UX dimensions.

Built for [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview). Works on any website or local HTML file.

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-18%2B-green)
![Playwright](https://img.shields.io/badge/playwright-chromium-orange)

---

## Sample Output

Here's what a real report looks like (from analyzing [talentsignals.co](https://talentsignals.co)):

### Dimension Scorecard
```
First Impression     ████████░░░░░░░░░░░░  4/5
Navigation & Flow    ██████░░░░░░░░░░░░░░  3/5
Emotional Arc        ██████░░░░░░░░░░░░░░  3/5
Trust & Polish       ██████░░░░░░░░░░░░░░  3/5
Time to Value        ██████░░░░░░░░░░░░░░  3/5
Responsive Quality   ██████████░░░░░░░░░░  4/5
Interactive Quality  ██████░░░░░░░░░░░░░░  3/5
────────────────────────────────────────────
COMPOSITE SCORE:     ██████████████░░░░░░  23/35
```

### Cognitive Walk-Through
```
Step  Action                      Friction   Emotion
───── ─────────────────────────── ────────── ──────────────
1     Land on homepage            LOW        Impressed
2     Read hero, decide to act    LOW        Confident
3     Click "Book a Demo"         ░░ MEDIUM  Uncertain
      → Opens mailto: instead of scheduling tool
4     Scroll to explore products  LOW        Engaged
5     Read testimonials           ░░ MEDIUM  Neutral
      → No real client names or photos
```

### Multi-Viewport Captures
The engine captures desktop (1440px), tablet (768px), and mobile (375px) simultaneously, plus hover states, scroll depth, form interactions, and error states.

> See `examples/` for the full HTML report with inline screenshots at every step.

---

## Quick Start

```bash
# 1. Clone into Claude Code skills directory
git clone https://github.com/andrew-shwetzer/human-experience.git ~/.claude/skills/human-experience

# 2. Install dependencies
cd ~/.claude/skills/human-experience
npm install
npx playwright install chromium

# 3. Run in Claude Code
# /human-experience https://your-site.com
```

That's it. Claude reads the skill prompt, runs the Playwright capture engine, analyzes the screenshots with vision, and generates a full HTML report.

---

## What It Captures

| Capture Type | Count | What It Tests |
|-------------|-------|---------------|
| Viewport screenshots | 6 | Desktop, tablet, mobile (viewport + full page) |
| Scroll depth | 4 | Content visibility at 25%, 50%, 75%, 100% |
| Hover states | 10-15 | Animation-aware before/after pairs |
| Click interactions | 10-20 | Every button, link, and interactive element |
| Form fields | All | Input types, validation, error states |
| CTA funnel | All | Follow every CTA to its destination |
| Error states | All | What happens when things break |

Total: **36+ captures per analysis**

---

## Usage

### As a Claude Code Skill

```
/human-experience https://example.com
/human-experience ./index.html --loop
/human-experience https://example.com --mode speed
/human-experience https://example.com --mode qa
/human-experience https://example.com --redesign
/human-experience https://example.com --persona "first-time visitor"
```

### Standalone Capture Engine

The Playwright capture script works independently:

```bash
node capture.mjs "https://example.com" --output-dir /tmp/hx-session --all
```

| Flag | Purpose |
|------|---------|
| `--all` | Full capture (screenshots, hover, interactions, forms, errors, funnel) |
| `--video` | Record interaction video |
| `--scroll` | Scroll-depth captures |
| `--dark-mode` | Dark mode variant |
| `--funnel` | Map all CTAs to their destinations |
| `--signup --agentmail-key <key>` | Test signup flow with disposable inbox |
| `--flow '<json>'` | Scripted multi-page journey |
| `--wait-until <strategy>` | Page load strategy: `networkidle` (default), `domcontentloaded`, `load` |

---

## Modes

| Mode | What It Does |
|------|-------------|
| **(default)** | Full 7-step simulation with HTML report |
| `--mode speed` | Friction inventory + priority fixes only (no narrative) |
| `--mode onboard` | Simulate first-time user, track time-to-value |
| `--mode compare` | Side-by-side comparison of two versions |
| `--mode qa` | Structured checklist: functional, visual, responsive, a11y |
| `--loop` | Iterate fixes until all 7 dimensions hit 5/5 (Karpathy-style ratchet) |
| `--redesign` | Generate HTML mockup implementing top fixes |

---

## The 7-Step Process

1. **Capture** - Render in Chromium, screenshot at 3 viewports, test all interactions
2. **First Impression** - The 50ms test. Hook, neutral, or bounce?
3. **Cognitive Walk-Through** - Step-by-step simulation with friction ratings and emotional states
4. **Multi-Viewport Analysis** - Layout, tap targets, thumb zones, breakpoint quality
5. **Emotional Arc** - Map confidence trajectory. Find the valleys.
6. **Friction Inventory** - Categorize every issue: blocker, high, medium, low
7. **Priority Fixes** - Top 3-5 changes ranked by impact, with effort estimates

---

## Dimension Scorecard

Every simulation scores 7 dimensions (1-5 each, 35 max):

| Dimension | What It Measures |
|-----------|-----------------|
| **First Impression** | Visual quality, hierarchy, 50ms gut reaction |
| **Navigation & Flow** | Can the user complete the journey without confusion |
| **Emotional Arc** | Confidence stays high, no valleys or plateaus |
| **Trust & Polish** | Professional feel, no broken or missing states |
| **Time to Value** | User gets value fast, no unnecessary friction |
| **Responsive Quality** | Works well across mobile, tablet, desktop |
| **Interactive Quality** | State changes, feedback, hover/click responses |

Rubric: 1 = broken, 2 = painful, 3 = acceptable, 4 = good, 5 = delightful.

---

## Architecture

```
┌─────────────────────────────────────────┐
│  skill.md          (the brain)          │
│  Claude's UX simulation prompt          │
│  7-step process + scoring rubrics       │
├─────────────────────────────────────────┤
│  capture.mjs       (the eyes)           │
│  Playwright engine: render, click,      │
│  screenshot, map funnels, test forms    │
├─────────────────────────────────────────┤
│  ux-research.md    (the standards)      │
│  Empirical UX research baselines        │
│  Cited thresholds, not opinions         │
└─────────────────────────────────────────┘
```

---

## Requirements

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)** (to use as a skill)
- **Node.js 18+**
- **Playwright** (installed via npm)

The capture script (`capture.mjs`) works standalone. The skill prompt (`skill.md`) requires Claude Code.

---

## License

[MIT](LICENSE)
