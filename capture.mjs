#!/usr/bin/env node
/**
 * capture.mjs - Playwright Vision Capture Engine for /human-experience
 *
 * Takes screenshots, records video, and interacts with UIs for vision-based analysis.
 * Outputs a manifest JSON with paths to all captured artifacts.
 *
 * Usage:
 *   node capture.mjs <path-or-url> [options]
 *
 * Options:
 *   --output-dir <dir>     Output directory (default: /tmp/hx-capture-<timestamp>)
 *   --video                Record video of the full session
 *   --interact             Click through interactive elements and capture state changes
 *   --viewports <list>     Comma-separated viewport names: mobile,tablet,desktop (default: all)
 *   --scroll               Capture scroll-depth screenshots (25%, 50%, 75%, 100%)
 *   --hover                Capture hover states on interactive elements (animation-aware)
 *   --forms                Test form fields with sample input
 *   --errors               Force error states where possible (empty submits, invalid input)
 *   --empty-state          Load page without data/content simulation
 *   --throttle <profile>   Network throttle: slow3g, fast3g, regular (default: none)
 *   --dark-mode            Capture in dark color scheme
 *   --funnel               Map all CTAs to their destinations (CTA funnel tracking)
 *   --flow <json>          Multi-page flow: JSON array of steps (see below)
 *   --signup               Test signup flow with AgentMail disposable inbox
 *   --agentmail-key <key>  AgentMail API key (or set AGENTMAIL_API_KEY env var)
 *   --all                  Enable all capture modes (interact, scroll, hover, forms, errors, funnel)
 *
 * Flow step format (--flow):
 *   [
 *     { "action": "click", "selector": "a:has-text('Try Now')" },
 *     { "action": "wait", "for": "networkidle" },
 *     { "action": "screenshot", "name": "signup-page" },
 *     { "action": "fill", "selector": "input[name=email]", "value": "{{email}}" },
 *     { "action": "click", "selector": "button[type=submit]" },
 *     { "action": "screenshot", "name": "post-submit" }
 *   ]
 *   Use {{email}} placeholder to inject AgentMail address when --signup is active.
 *
 * Signup mode (--signup):
 *   Creates a disposable AgentMail inbox, uses it for any signup forms found,
 *   polls for confirmation emails, screenshots the email content, and follows
 *   verification links. Requires --agentmail-key or AGENTMAIL_API_KEY env var.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));

if (!target) {
  console.error('Usage: node capture.mjs <path-or-url> [options]');
  process.exit(1);
}

// Parse options
const opts = {
  outputDir: getArg('--output-dir') || `/tmp/hx-capture-${Date.now()}`,
  video: hasFlag('--video'),
  interact: hasFlag('--interact') || hasFlag('--all'),
  scroll: hasFlag('--scroll') || hasFlag('--all'),
  hover: hasFlag('--hover') || hasFlag('--all'),
  forms: hasFlag('--forms') || hasFlag('--all'),
  errors: hasFlag('--errors') || hasFlag('--all'),
  emptyState: hasFlag('--empty-state'),
  darkMode: hasFlag('--dark-mode'),
  throttle: getArg('--throttle') || null,
  viewports: (getArg('--viewports') || 'mobile,tablet,desktop').split(','),
  funnel: hasFlag('--funnel') || hasFlag('--all'),
  flow: getArg('--flow') || null,
  signup: hasFlag('--signup'),
  agentmailKey: getArg('--agentmail-key') || process.env.AGENTMAIL_API_KEY || null,
  all: hasFlag('--all'),
  waitUntil: getArg('--wait-until') || 'networkidle',
};

function hasFlag(name) { return args.includes(name); }
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// Viewport definitions
const VIEWPORTS = {
  mobile:  { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet:  { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
  'desktop-hd': { width: 1920, height: 1080, deviceScaleFactor: 1 },
};

// Network throttle profiles
const THROTTLE_PROFILES = {
  slow3g:  { offline: false, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8, latency: 400 },
  fast3g:  { offline: false, downloadThroughput: (1.5 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 300 },
  regular: { offline: false, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8, latency: 20 },
};

const manifest = {
  target,
  timestamp: new Date().toISOString(),
  outputDir: opts.outputDir,
  captures: [],
  interactiveElements: [],
  formFields: [],
  errors: [],
  metrics: {},
  ctaFunnel: [],
  flowResults: [],
  signupFlow: null,
};

// ============================================================================
// AgentMail Integration
// ============================================================================

class AgentMailClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.agentmail.to/v0';
  }

  async request(method, path, body = null) {
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${this.baseUrl}${path}`, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AgentMail API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  async createInbox(prefix = 'hx-test') {
    const username = `${prefix}-${Date.now()}`;
    const result = await this.request('POST', '/inboxes', {
      username,
      display_name: `HX Test ${new Date().toISOString().slice(0, 10)}`,
    });
    return result;
  }

  async listMessages(inboxId, limit = 10) {
    return this.request('GET', `/inboxes/${inboxId}/messages?limit=${limit}`);
  }

  async getMessage(inboxId, messageId) {
    return this.request('GET', `/inboxes/${inboxId}/messages/${messageId}`);
  }

  async pollForMessage(inboxId, { timeout = 60000, interval = 3000, subjectContains = null } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const response = await this.listMessages(inboxId);
      const messages = response.messages || response.data || [];
      if (messages.length > 0) {
        if (subjectContains) {
          const match = messages.find(m =>
            (m.subject || '').toLowerCase().includes(subjectContains.toLowerCase())
          );
          if (match) return match;
        } else {
          return messages[0];
        }
      }
      await new Promise(r => setTimeout(r, interval));
    }
    return null;
  }

  async deleteInbox(inboxId) {
    return this.request('DELETE', `/inboxes/${inboxId}`).catch(() => null);
  }
}

// ============================================================================
// Animation-Aware Hover Helper
// ============================================================================

async function hoverAndWaitForAnimation(page, element, maxWait = 1500) {
  // Set up animation/transition listeners before hovering
  await page.evaluate(() => {
    window.__hxAnimDone = false;
    window.__hxAnimTimeout = null;

    const handler = () => {
      clearTimeout(window.__hxAnimTimeout);
      // Wait a bit more in case there are chained animations
      window.__hxAnimTimeout = setTimeout(() => { window.__hxAnimDone = true; }, 150);
    };

    document.addEventListener('transitionend', handler, { once: false });
    document.addEventListener('animationend', handler, { once: false });

    // Also set a flag after a short delay if no animations fire at all
    window.__hxNoAnimTimer = setTimeout(() => {
      if (!window.__hxAnimDone) window.__hxAnimDone = true;
    }, 800);
  });

  await element.hover();

  // Wait for animations to complete or timeout
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    const done = await page.evaluate(() => window.__hxAnimDone);
    if (done) break;
    await page.waitForTimeout(100);
  }

  // Small extra buffer for visual settling
  await page.waitForTimeout(100);

  // Cleanup listeners
  await page.evaluate(() => {
    clearTimeout(window.__hxAnimTimeout);
    clearTimeout(window.__hxNoAnimTimer);
  });
}

// ============================================================================
// CTA Funnel Mapper
// ============================================================================

async function mapCTAFunnel(browser, url, outputDir) {
  const funnel = [];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: opts.waitUntil, timeout: 30000 });
  await page.waitForTimeout(500);

  // Discover all CTA-like links and buttons
  const ctas = await page.evaluate(() => {
    const results = [];
    const ctaSelectors = [
      'a[href]:not([href^="#"]):not([href^="javascript"]):not([href^="mailto"])',
      'button[type="submit"]',
      '[role="button"][onclick]',
    ];

    for (const selector of ctaSelectors) {
      document.querySelectorAll(selector).forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return;

        const text = (el.textContent || '').trim().slice(0, 80);
        if (!text) return;

        // Score CTA prominence (bigger, more contrast = higher score)
        const fontSize = parseFloat(style.fontSize);
        const isBold = parseInt(style.fontWeight) >= 600;
        const hasBackground = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent';
        const area = rect.width * rect.height;
        const prominence = (fontSize > 14 ? 2 : 0) + (isBold ? 1 : 0) + (hasBackground ? 3 : 0) + (area > 5000 ? 2 : 0);

        results.push({
          tag: el.tagName.toLowerCase(),
          text,
          href: el.href || null,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          prominence,
          classes: el.className?.toString().slice(0, 100) || '',
        });
      });
    }

    // Sort by prominence (highest first) and deduplicate by href
    results.sort((a, b) => b.prominence - a.prominence);
    const seen = new Set();
    return results.filter(r => {
      const key = r.href || r.text;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  // Follow each CTA to its destination (top 15 most prominent)
  for (let i = 0; i < Math.min(ctas.length, 15); i++) {
    const cta = ctas[i];
    if (!cta.href) continue;

    const entry = {
      index: i,
      sourceText: cta.text,
      sourceHref: cta.href,
      prominence: cta.prominence,
      destination: null,
      destinationTitle: null,
      destinationScreenshot: null,
      redirectChain: [],
      error: null,
    };

    try {
      // Open CTA destination in a new page
      const destPage = await context.newPage();

      // Track redirects
      destPage.on('response', (response) => {
        if (response.status() >= 300 && response.status() < 400) {
          entry.redirectChain.push({
            from: response.url(),
            status: response.status(),
            to: response.headers()['location'] || null,
          });
        }
      });

      await destPage.goto(cta.href, { waitUntil: opts.waitUntil, timeout: 15000 }).catch(() => {});
      await destPage.waitForTimeout(500);

      entry.destination = destPage.url();
      entry.destinationTitle = await destPage.title().catch(() => '');

      // Screenshot the landing page
      const screenshotPath = `${outputDir}/funnel-cta-${i}.png`;
      await destPage.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled' });
      entry.destinationScreenshot = screenshotPath;

      // Check for signup/login forms on the destination
      const hasSignupForm = await destPage.evaluate(() => {
        const emailInput = document.querySelector('input[type="email"], input[name*="email"]');
        const passwordInput = document.querySelector('input[type="password"]');
        const form = document.querySelector('form');
        return {
          hasEmail: !!emailInput,
          hasPassword: !!passwordInput,
          hasForm: !!form,
          formAction: form?.action || null,
          inputCount: document.querySelectorAll('input:not([type="hidden"])').length,
        };
      });
      entry.destinationForm = hasSignupForm;

      await destPage.close();
    } catch (err) {
      entry.error = err.message;
    }

    funnel.push(entry);
  }

  await context.close();
  return funnel;
}

// ============================================================================
// Multi-Page Flow Runner
// ============================================================================

async function runFlow(browser, url, flowSteps, outputDir, agentMailEmail = null) {
  const results = [];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: opts.waitUntil, timeout: 30000 });
  await page.waitForTimeout(500);

  for (let i = 0; i < flowSteps.length; i++) {
    const step = flowSteps[i];
    const result = { step: i, action: step.action, status: 'ok', detail: null };

    try {
      switch (step.action) {
        case 'click': {
          const el = page.locator(step.selector).first();
          await el.scrollIntoViewIfNeeded();
          await el.click({ timeout: 5000 });
          await page.waitForTimeout(500);
          result.detail = `Clicked: ${step.selector}`;
          result.currentUrl = page.url();
          break;
        }

        case 'fill': {
          let value = step.value;
          if (value === '{{email}}' && agentMailEmail) {
            value = agentMailEmail;
          }
          const el = page.locator(step.selector).first();
          await el.scrollIntoViewIfNeeded();
          await el.fill(value);
          await page.waitForTimeout(200);
          result.detail = `Filled ${step.selector} with ${value}`;
          break;
        }

        case 'type': {
          let value = step.value;
          if (value === '{{email}}' && agentMailEmail) {
            value = agentMailEmail;
          }
          const el = page.locator(step.selector).first();
          await el.scrollIntoViewIfNeeded();
          await el.pressSequentially(value, { delay: 50 });
          await page.waitForTimeout(200);
          result.detail = `Typed into ${step.selector}`;
          break;
        }

        case 'wait': {
          if (step.for === 'networkidle') {
            await page.waitForLoadState(opts.waitUntil);
          } else if (step.for === 'navigation') {
            await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
          } else if (step.selector) {
            await page.waitForSelector(step.selector, { timeout: step.timeout || 5000 });
          } else if (step.ms) {
            await page.waitForTimeout(step.ms);
          }
          result.detail = `Waited for: ${step.for || step.selector || step.ms + 'ms'}`;
          result.currentUrl = page.url();
          break;
        }

        case 'screenshot': {
          const name = step.name || `flow-step-${i}`;
          const path = `${outputDir}/flow-${name}.png`;
          await page.screenshot({
            path,
            fullPage: step.fullPage || false,
            animations: 'disabled',
          });
          result.screenshotPath = path;
          result.detail = `Screenshot: ${name}`;
          result.currentUrl = page.url();
          result.pageTitle = await page.title().catch(() => '');
          break;
        }

        case 'select': {
          const el = page.locator(step.selector).first();
          await el.selectOption(step.value);
          result.detail = `Selected ${step.value} in ${step.selector}`;
          break;
        }

        case 'check': {
          const el = page.locator(step.selector).first();
          await el.check();
          result.detail = `Checked: ${step.selector}`;
          break;
        }

        case 'navigate': {
          await page.goto(step.url, { waitUntil: opts.waitUntil, timeout: 15000 });
          await page.waitForTimeout(500);
          result.detail = `Navigated to: ${step.url}`;
          result.currentUrl = page.url();
          break;
        }

        case 'press': {
          await page.keyboard.press(step.key);
          result.detail = `Pressed key: ${step.key}`;
          break;
        }

        default:
          result.status = 'skipped';
          result.detail = `Unknown action: ${step.action}`;
      }
    } catch (err) {
      result.status = 'error';
      result.error = err.message;
      // Screenshot the error state
      const errPath = `${outputDir}/flow-error-step-${i}.png`;
      await page.screenshot({ path: errPath, fullPage: false }).catch(() => {});
      result.errorScreenshot = errPath;
    }

    results.push(result);
  }

  await context.close();
  return results;
}

// ============================================================================
// Signup Flow with AgentMail
// ============================================================================

async function testSignupFlow(browser, url, outputDir, agentMailKey) {
  const mail = new AgentMailClient(agentMailKey);
  const signupResult = {
    inboxCreated: false,
    email: null,
    inboxId: null,
    formFound: false,
    formSubmitted: false,
    confirmationReceived: false,
    confirmationEmail: null,
    verificationLinkFollowed: false,
    captures: [],
    errors: [],
  };

  let inbox = null;

  try {
    // Step 1: Create disposable inbox
    console.error('[signup] Creating AgentMail inbox...');
    inbox = await mail.createInbox('hx-signup');
    signupResult.inboxCreated = true;
    const rawId = inbox.inboxId || inbox.inbox_id || inbox.id;
    // inbox_id from AgentMail IS the full email (e.g. "user@agentmail.to")
    signupResult.inboxId = rawId;
    signupResult.email = rawId.includes('@') ? rawId : `${rawId}@agentmail.to`;
    console.error(`[signup] Inbox created: ${signupResult.email}`);

    // Step 2: Navigate and find signup form
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: opts.waitUntil, timeout: 30000 });
    await page.waitForTimeout(500);

    // Look for signup/register CTAs and follow them
    const signupCTA = await page.$([
      'a:has-text("Sign Up")',
      'a:has-text("Sign up")',
      'a:has-text("Register")',
      'a:has-text("Get Started")',
      'a:has-text("Try Now")',
      'a:has-text("Try Free")',
      'a:has-text("Start Free")',
      'a:has-text("Create Account")',
      'button:has-text("Sign Up")',
      'button:has-text("Get Started")',
      'button:has-text("Try Now")',
      'button:has-text("Try Free")',
    ].join(', '));

    if (signupCTA) {
      const ctaText = await signupCTA.textContent().catch(() => 'CTA');
      const ctaHref = await signupCTA.getAttribute('href').catch(() => null);
      console.error(`[signup] Found signup CTA: "${ctaText.trim()}" → ${ctaHref || '(no href)'}`);

      // Screenshot before clicking
      const beforePath = `${outputDir}/signup-before-cta.png`;
      await page.screenshot({ path: beforePath, fullPage: false, animations: 'disabled' });
      signupResult.captures.push({ type: 'before-cta', path: beforePath });

      // Navigate directly to the href if it's an absolute URL (more reliable than click)
      if (ctaHref && (ctaHref.startsWith('http') || ctaHref.startsWith('/'))) {
        const targetUrl = ctaHref.startsWith('http') ? ctaHref : new URL(ctaHref, url).href;
        console.error(`[signup] Navigating directly to: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: opts.waitUntil, timeout: 15000 }).catch(() => {});
      } else {
        // Fallback: click and hope for navigation
        await Promise.all([
          page.waitForNavigation({ timeout: 10000 }).catch(() => {}),
          signupCTA.click(),
        ]);
      }
      await page.waitForTimeout(2000);

      // Screenshot the signup/landing page
      const afterPath = `${outputDir}/signup-landing-page.png`;
      await page.screenshot({ path: afterPath, fullPage: false, animations: 'disabled' });
      signupResult.captures.push({ type: 'signup-page', path: afterPath, url: page.url() });
      console.error(`[signup] Landed on: ${page.url()}`);
    }

    // Step 3: If we landed on a sign-in page, look for a "Sign up" link to switch FIRST
    // (must happen before querying form fields, since Clerk/Auth0 re-render the DOM on switch)
    const signUpLink = await page.$([
      'a:has-text("Sign up")',
      'a:has-text("Create account")',
      'a:has-text("Register")',
      'a:has-text("Don\'t have an account")',
      '.cl-footerAction__signUp a',
      '[data-localization-key="signIn.start.actionLink"]',
    ].join(', '));

    if (signUpLink) {
      const linkText = await signUpLink.textContent().catch(() => '');
      console.error(`[signup] Found sign-up link on sign-in page: "${linkText.trim()}"`);
      await signUpLink.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await page.waitForLoadState(opts.waitUntil).catch(() => {});

      const switchPath = `${outputDir}/signup-switched-to-register.png`;
      await page.screenshot({ path: switchPath, fullPage: false, animations: 'disabled' });
      signupResult.captures.push({ type: 'switched-to-register', path: switchPath, url: page.url() });
      console.error(`[signup] Switched to register page: ${page.url()}`);
    }

    // NOW query form fields (after any sign-in → sign-up switch, so DOM is fresh)
    // Broad selectors to handle Clerk, Auth0, Supabase, Firebase, custom auth
    // Two-pass email field detection: specific selectors first, then broader fallback
    // IMPORTANT: avoid overly generic selectors like .cl-input that match name fields too
    let emailField = await page.$([
      'input[type="email"]',
      'input[name="email"]',
      'input[name="Email"]',
      'input[name="emailAddress"]',
      'input[name="identifier"]',
      'input[id="email"]',
      'input[id="emailAddress"]',
      'input[id="identifier"]',
      'input[placeholder*="email" i]',
      'input[autocomplete="email"]',
      // Clerk-specific (targeted, not generic .cl-input)
      '.cl-formFieldInput[name="identifier"]',
      '.cl-formFieldInput[name="emailAddress"]',
      // Auth0
      'input[name="email"][data-action-button-state]',
    ].join(', '));

    // Broader fallback: look for input near an "email" label
    if (!emailField) {
      // Try label-based detection (works with Clerk, most auth providers)
      const emailLabel = await page.$('label:has-text("email"), label:has-text("Email")');
      if (emailLabel) {
        const forAttr = await emailLabel.getAttribute('for').catch(() => null);
        if (forAttr) {
          emailField = await page.$(`#${forAttr}`);
        }
        if (!emailField) {
          // Try sibling/child input of the label's parent
          emailField = await page.$(':has(> label:has-text("email")) input, :has(> label:has-text("Email")) input');
        }
      }
    }

    // Last resort: username field (but NOT generic .cl-input)
    if (!emailField) {
      emailField = await page.$('input[name="username"], input[autocomplete="username"]');
    }

    if (emailField) {
      signupResult.formFound = true;

      // Fill name fields FIRST (before email, so we don't accidentally overwrite)
      const nameFields = [
        ['input[name="name"], input[name="full_name"], input[name="fullName"]', 'HX Test User'],
        ['input[name="firstName"], input[name="first_name"]', 'HX'],
        ['input[name="lastName"], input[name="last_name"]', 'Tester'],
      ];
      for (const [selector, value] of nameFields) {
        const field = await page.$(selector);
        if (field) {
          await field.fill(value).catch(() => {});
          console.error(`[signup] Filled name field: ${selector} = "${value}"`);
        }
      }

      // Fill password if present
      const passwordField = await page.$('input[type="password"]');
      if (passwordField) {
        await passwordField.fill('TestPassword123!');
      }

      // Fill email LAST (ensures it's not overwritten by name field logic)
      console.error(`[signup] Found email field, filling with ${signupResult.email}`);
      await emailField.scrollIntoViewIfNeeded();
      await emailField.fill(signupResult.email);

      // Screenshot filled form
      const filledPath = `${outputDir}/signup-form-filled.png`;
      await page.screenshot({ path: filledPath, fullPage: false, animations: 'disabled' });
      signupResult.captures.push({ type: 'form-filled', path: filledPath });

      // Find and click submit
      const submitBtn = await page.$([
        'button[type="submit"]',
        'button:has-text("Sign Up")',
        'button:has-text("Sign up")',
        'button:has-text("Register")',
        'button:has-text("Create Account")',
        'button:has-text("Create account")',
        'button:has-text("Get Started")',
        'button:has-text("Continue")',
        'button:has-text("Submit")',
        'button:has-text("Next")',
        'input[type="submit"]',
        // Clerk-specific
        '.cl-formButtonPrimary',
        'button[data-localization-key]',
      ].join(', '));

      if (submitBtn) {
        console.error('[signup] Submitting form...');
        await submitBtn.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(3000);
        await page.waitForLoadState(opts.waitUntil).catch(() => {});

        signupResult.formSubmitted = true;

        // Screenshot post-submit state
        const postPath = `${outputDir}/signup-post-submit.png`;
        await page.screenshot({ path: postPath, fullPage: false, animations: 'disabled' });
        signupResult.captures.push({ type: 'post-submit', path: postPath, url: page.url() });

        console.error('[signup] Form submitted, polling for confirmation email...');
      }
    } else {
      // Last resort: try to find ANY visible text input on the page
      const fallbackInput = await page.$('input:visible:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])');
      if (fallbackInput) {
        signupResult.formFound = true;
        console.error(`[signup] Using fallback input field, filling with ${signupResult.email}`);
        await fallbackInput.fill(signupResult.email);

        const filledPath = `${outputDir}/signup-form-filled.png`;
        await page.screenshot({ path: filledPath, fullPage: false, animations: 'disabled' });
        signupResult.captures.push({ type: 'form-filled', path: filledPath });

        // Try to submit
        const submitBtn = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Next"), .cl-formButtonPrimary');
        if (submitBtn) {
          console.error('[signup] Submitting via fallback...');
          await submitBtn.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(3000);
          await page.waitForLoadState(opts.waitUntil).catch(() => {});
          signupResult.formSubmitted = true;

          const postPath = `${outputDir}/signup-post-submit.png`;
          await page.screenshot({ path: postPath, fullPage: false, animations: 'disabled' });
          signupResult.captures.push({ type: 'post-submit', path: postPath, url: page.url() });
        }
      } else {
        console.error('[signup] No email field found on page or after following CTA');
        signupResult.errors.push('No email input field found');
      }
    }

    await context.close();

    // Step 4: Poll for confirmation email
    if (signupResult.formSubmitted && signupResult.inboxId) {
      const message = await mail.pollForMessage(signupResult.inboxId, {
        timeout: 90000,  // Wait up to 90 seconds
        interval: 5000,
      });

      if (message) {
        signupResult.confirmationReceived = true;
        signupResult.confirmationEmail = {
          id: message.message_id || message.id,
          from: message.from,
          subject: message.subject,
          preview: (message.preview || message.text || '').slice(0, 200),
          receivedAt: message.timestamp || message.created_at,
        };
        console.error(`[signup] Confirmation email received: "${message.subject}"`);

        // Try to get full message content
        const fullMessage = await mail.getMessage(
          signupResult.inboxId,
          message.message_id || message.id
        ).catch(() => null);

        if (fullMessage) {
          signupResult.confirmationEmail.htmlContent = (fullMessage.html || '').slice(0, 5000);
          signupResult.confirmationEmail.textContent = (fullMessage.text || '').slice(0, 2000);

          // Extract verification/confirmation links from email
          const linkRegex = /https?:\/\/[^\s"'<>]+(?:verify|confirm|activate|welcome|onboard)[^\s"'<>]*/gi;
          const htmlContent = fullMessage.html || fullMessage.text || '';
          const links = htmlContent.match(linkRegex) || [];

          // Also try a broader link extraction from HTML
          const hrefRegex = /href="(https?:\/\/[^"]+)"/gi;
          let match;
          while ((match = hrefRegex.exec(htmlContent)) !== null) {
            if (!links.includes(match[1])) links.push(match[1]);
          }

          signupResult.confirmationEmail.links = links.slice(0, 10);

          // Step 5: Follow verification link if found
          if (links.length > 0) {
            console.error(`[signup] Found ${links.length} links, following first verification link...`);
            const verifyContext = await browser.newContext({
              viewport: { width: 1440, height: 900 },
              deviceScaleFactor: 2,
            });
            const verifyPage = await verifyContext.newPage();

            // Try the most likely verification link first
            const verifyLink = links.find(l =>
              /verify|confirm|activate/.test(l)
            ) || links[0];

            try {
              await verifyPage.goto(verifyLink, { waitUntil: opts.waitUntil, timeout: 15000 });
              await verifyPage.waitForTimeout(1000);

              const verifyPath = `${outputDir}/signup-verification-result.png`;
              await verifyPage.screenshot({ path: verifyPath, fullPage: false, animations: 'disabled' });
              signupResult.captures.push({
                type: 'verification-result',
                path: verifyPath,
                url: verifyPage.url(),
                linkFollowed: verifyLink,
              });
              signupResult.verificationLinkFollowed = true;
              console.error(`[signup] Verification link followed successfully`);
            } catch (err) {
              signupResult.errors.push(`Failed to follow verification link: ${err.message}`);
            }

            await verifyContext.close();
          }
        }
      } else {
        console.error('[signup] No confirmation email received within timeout');
        signupResult.errors.push('No confirmation email received within 90 seconds');
      }
    }
  } catch (err) {
    signupResult.errors.push(err.message);
    console.error(`[signup] Error: ${err.message}`);
  }

  // Cleanup: delete inbox to avoid hitting free tier limit (3 inboxes max)
  if (signupResult.inboxId) {
    try {
      await mail.deleteInbox(signupResult.inboxId);
      console.error(`[signup] Cleaned up inbox: ${signupResult.inboxId}`);
    } catch (cleanupErr) {
      console.error(`[signup] Warning: failed to cleanup inbox: ${cleanupErr.message}`);
    }
  }

  return signupResult;
}

// ============================================================================
// Main Capture Engine
// ============================================================================

async function main() {
  mkdirSync(opts.outputDir, { recursive: true });

  const url = target.startsWith('http') ? target : `file://${resolve(target)}`;

  const browser = await chromium.launch({ headless: true });

  try {
    // Phase 1: Multi-viewport screenshots
    for (const vpName of opts.viewports) {
      const vp = VIEWPORTS[vpName];
      if (!vp) { console.warn(`Unknown viewport: ${vpName}`); continue; }

      const contextOpts = {
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.deviceScaleFactor || 1,
        isMobile: vp.isMobile || false,
        hasTouch: vp.hasTouch || false,
        colorScheme: opts.darkMode ? 'dark' : 'light',
      };

      // Add video recording if requested
      if (opts.video) {
        contextOpts.recordVideo = {
          dir: `${opts.outputDir}/videos/`,
          size: { width: vp.width, height: Math.min(vp.height, 720) },
        };
      }

      const context = await browser.newContext(contextOpts);
      const page = await context.newPage();

      // Apply network throttle
      if (opts.throttle && THROTTLE_PROFILES[opts.throttle]) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.emulateNetworkConditions', THROTTLE_PROFILES[opts.throttle]);
      }

      // Navigate and wait for content to settle
      const loadStart = Date.now();
      await page.goto(url, { waitUntil: opts.waitUntil, timeout: 30000 });
      await page.waitForTimeout(500); // Let fonts/animations settle
      const loadTime = Date.now() - loadStart;

      manifest.metrics[vpName] = { loadTimeMs: loadTime };

      // Full page screenshot
      const fpPath = `${opts.outputDir}/${vpName}-full.png`;
      await page.screenshot({ path: fpPath, fullPage: true, animations: 'disabled' });
      manifest.captures.push({ type: 'full-page', viewport: vpName, path: fpPath });

      // Viewport-only screenshot (above the fold)
      const vpPath = `${opts.outputDir}/${vpName}-viewport.png`;
      await page.screenshot({ path: vpPath, fullPage: false, animations: 'disabled' });
      manifest.captures.push({ type: 'above-fold', viewport: vpName, path: vpPath });

      // Scroll depth screenshots
      if (opts.scroll) {
        const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        const viewportHeight = vp.height;
        const scrollPositions = [0.25, 0.5, 0.75, 1.0];

        for (const pct of scrollPositions) {
          const scrollY = Math.min((pageHeight - viewportHeight) * pct, pageHeight - viewportHeight);
          await page.evaluate((y) => window.scrollTo(0, y), scrollY);
          await page.waitForTimeout(300);
          const scrollPath = `${opts.outputDir}/${vpName}-scroll-${Math.round(pct * 100)}.png`;
          await page.screenshot({ path: scrollPath, fullPage: false, animations: 'disabled' });
          manifest.captures.push({ type: `scroll-${Math.round(pct * 100)}%`, viewport: vpName, path: scrollPath });
        }
        // Reset scroll
        await page.evaluate(() => window.scrollTo(0, 0));
      }

      // Discover interactive elements (only on desktop to avoid duplicates)
      if (vpName === 'desktop' || (opts.viewports.length === 1 && vpName === opts.viewports[0])) {
        const elements = await page.evaluate(() => {
          const interactives = [];
          const selectors = 'a, button, [role="button"], input, select, textarea, [onclick], [tabindex]:not([tabindex="-1"]), details, summary';
          document.querySelectorAll(selectors).forEach((el, i) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            interactives.push({
              index: i,
              tag: el.tagName.toLowerCase(),
              type: el.type || null,
              text: (el.textContent || '').trim().slice(0, 80),
              placeholder: el.placeholder || null,
              name: el.name || null,
              id: el.id || null,
              href: el.href || null,
              role: el.getAttribute('role'),
              ariaLabel: el.getAttribute('aria-label'),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              isVisible: rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden',
              tapTargetOk: rect.width >= 44 && rect.height >= 44,
            });
          });
          return interactives;
        });
        manifest.interactiveElements = elements;

        // Identify form fields
        manifest.formFields = elements.filter(e =>
          ['input', 'select', 'textarea'].includes(e.tag)
        );
      }

      // Hover state captures (animation-aware)
      if (opts.hover && vpName === 'desktop') {
        const hoverTargets = await page.$$('a, button, [role="button"], [class*="card"], [class*="feature"], [class*="item"]');
        const seen = new Set();
        let hoverIdx = 0;

        for (let i = 0; i < hoverTargets.length && hoverIdx < 15; i++) {
          try {
            const isVisible = await hoverTargets[i].isVisible();
            if (!isVisible) continue;

            const text = await hoverTargets[i].textContent().catch(() => '');
            const trimmed = (text || '').trim().slice(0, 50);
            if (seen.has(trimmed)) continue;
            seen.add(trimmed);

            await hoverTargets[i].scrollIntoViewIfNeeded();

            // Screenshot BEFORE hover for comparison
            const beforePath = `${opts.outputDir}/hover-${hoverIdx}-before.png`;
            await page.screenshot({ path: beforePath, fullPage: false, animations: 'disabled' });

            // Hover with animation awareness
            await hoverAndWaitForAnimation(page, hoverTargets[i]);

            // Screenshot AFTER hover (with animations allowed to show final state)
            const afterPath = `${opts.outputDir}/hover-${hoverIdx}-after.png`;
            await page.screenshot({ path: afterPath, fullPage: false });

            manifest.captures.push({
              type: 'hover-state',
              viewport: vpName,
              beforePath,
              afterPath,
              element: trimmed,
              index: hoverIdx,
              animationAware: true,
            });

            // Move mouse away to reset
            await page.mouse.move(0, 0);
            await page.waitForTimeout(200);

            hoverIdx++;
          } catch (e) { /* element may have moved/hidden */ }
        }
      }

      // Interactive walkthrough: click through elements and capture state changes
      if (opts.interact && vpName === 'desktop') {
        const clickTargets = await page.$$('button, [role="button"], a[href="#"], a[href^="javascript"], details > summary');
        for (let i = 0; i < Math.min(clickTargets.length, 15); i++) {
          try {
            const isVisible = await clickTargets[i].isVisible();
            if (!isVisible) continue;

            // Screenshot before click
            await clickTargets[i].scrollIntoViewIfNeeded();
            await page.waitForTimeout(200);
            const beforePath = `${opts.outputDir}/interact-${i}-before.png`;
            await page.screenshot({ path: beforePath, fullPage: false, animations: 'disabled' });

            // Click
            await clickTargets[i].click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(500);

            // Screenshot after click
            const afterPath = `${opts.outputDir}/interact-${i}-after.png`;
            await page.screenshot({ path: afterPath, fullPage: false, animations: 'disabled' });

            const text = await clickTargets[i].textContent().catch(() => '');
            manifest.captures.push({
              type: 'interaction',
              viewport: vpName,
              beforePath,
              afterPath,
              element: (text || '').trim().slice(0, 50),
              index: i,
            });
          } catch (e) { /* element may have moved/hidden */ }
        }
      }

      // Form testing: fill fields with sample data and capture
      if (opts.forms && vpName === 'desktop') {
        const inputs = await page.$$('input:visible, select:visible, textarea:visible');
        for (let i = 0; i < inputs.length; i++) {
          try {
            const inputType = await inputs[i].getAttribute('type') || 'text';
            const name = await inputs[i].getAttribute('name') || `field-${i}`;

            await inputs[i].scrollIntoViewIfNeeded();

            const sampleData = {
              text: 'Sample text input',
              email: 'test@example.com',
              password: 'TestPassword123!',
              tel: '555-0100',
              number: '42',
              url: 'https://example.com',
              search: 'search query',
              date: '2026-03-09',
            };

            if (inputType === 'select' || (await inputs[i].tagName) === 'SELECT') {
              // Select first non-empty option
              const options = await inputs[i].$$('option');
              if (options.length > 1) {
                await inputs[i].selectOption({ index: 1 });
              }
            } else if (inputType === 'checkbox' || inputType === 'radio') {
              await inputs[i].check().catch(() => {});
            } else if (inputType !== 'hidden' && inputType !== 'submit' && inputType !== 'button') {
              const value = sampleData[inputType] || sampleData.text;
              await inputs[i].fill(value).catch(() => {});
            }

            await page.waitForTimeout(200);
            const formPath = `${opts.outputDir}/form-field-${i}-${name}.png`;
            await page.screenshot({ path: formPath, fullPage: false, animations: 'disabled' });
            manifest.captures.push({
              type: 'form-fill',
              viewport: vpName,
              path: formPath,
              fieldName: name,
              fieldType: inputType,
            });
          } catch (e) { /* skip problematic fields */ }
        }
      }

      // Error state testing
      if (opts.errors && vpName === 'desktop') {
        // Try submitting forms without filling required fields
        const forms = await page.$$('form');
        for (let i = 0; i < forms.length; i++) {
          try {
            const submitBtn = await forms[i].$('button[type="submit"], input[type="submit"], button:not([type])');
            if (submitBtn) {
              // Clear any pre-filled values
              const requiredFields = await forms[i].$$('input[required], textarea[required]');
              for (const field of requiredFields) {
                await field.fill('').catch(() => {});
              }

              await submitBtn.click({ timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(500);

              const errorPath = `${opts.outputDir}/error-form-${i}.png`;
              await page.screenshot({ path: errorPath, fullPage: false, animations: 'disabled' });
              manifest.captures.push({
                type: 'error-state',
                viewport: vpName,
                path: errorPath,
                context: `Form ${i} - empty submit`,
              });
            }
          } catch (e) { /* skip */ }
        }

        // Try invalid email format
        const emailFields = await page.$$('input[type="email"]');
        for (let i = 0; i < emailFields.length; i++) {
          try {
            await emailFields[i].fill('notanemail');
            const form = await emailFields[i].evaluate(el => el.closest('form'));
            if (form) {
              await page.evaluate(f => {
                const btn = f.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
                if (btn) btn.click();
              }, form);
            }
            await page.waitForTimeout(500);
            const errPath = `${opts.outputDir}/error-email-${i}.png`;
            await page.screenshot({ path: errPath, fullPage: false, animations: 'disabled' });
            manifest.captures.push({
              type: 'error-state',
              viewport: vpName,
              path: errPath,
              context: `Invalid email field ${i}`,
            });
          } catch (e) { /* skip */ }
        }
      }

      // Collect page metrics
      const metrics = await page.evaluate(() => {
        const styles = window.getComputedStyle(document.body);
        const allElements = document.querySelectorAll('*');
        const fontSizes = new Set();
        const colors = new Set();
        const spacings = new Set();

        for (const el of allElements) {
          const cs = window.getComputedStyle(el);
          fontSizes.add(cs.fontSize);
          colors.add(cs.color);
          colors.add(cs.backgroundColor);
          spacings.add(cs.marginTop);
          spacings.add(cs.paddingTop);
        }

        return {
          title: document.title,
          bodyFontSize: styles.fontSize,
          bodyFontFamily: styles.fontFamily,
          bodyColor: styles.color,
          bodyBgColor: styles.backgroundColor,
          uniqueFontSizes: fontSizes.size,
          uniqueColors: colors.size,
          totalElements: allElements.length,
          hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
          linkCount: document.querySelectorAll('a').length,
          imageCount: document.querySelectorAll('img').length,
          formCount: document.querySelectorAll('form').length,
          buttonCount: document.querySelectorAll('button, [role="button"]').length,
          headingStructure: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => ({
            level: h.tagName,
            text: h.textContent.trim().slice(0, 60),
          })),
          contrastIssues: (() => {
            const issues = [];
            document.querySelectorAll('p, span, a, button, h1, h2, h3, h4, h5, h6, li, td, th, label').forEach(el => {
              const s = window.getComputedStyle(el);
              if (s.visibility === 'hidden' || s.display === 'none') return;
              const color = s.color;
              const bg = s.backgroundColor;
              if (color === bg && color !== 'rgba(0, 0, 0, 0)') {
                issues.push({ element: el.tagName, text: el.textContent.trim().slice(0, 30), color, bg });
              }
            });
            return issues;
          })(),
        };
      });

      manifest.metrics[vpName] = { ...manifest.metrics[vpName], ...metrics };

      // Get video path before closing
      if (opts.video) {
        const videoPath = await page.video()?.path();
        if (videoPath) {
          manifest.captures.push({ type: 'video', viewport: vpName, path: videoPath });
        }
      }

      await context.close();
    }

    // Phase 2: Accessibility checks
    const accessContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const accessPage = await accessContext.newPage();
    await accessPage.goto(url, { waitUntil: opts.waitUntil, timeout: 30000 });

    try {
      const a11ySnapshot = await accessPage.accessibility.snapshot();
      manifest.accessibilityTree = a11ySnapshot;
    } catch (e) {
      try {
        const ariaSnapshot = await accessPage.locator('body').ariaSnapshot();
        manifest.accessibilityTree = ariaSnapshot;
      } catch (e2) {
        manifest.accessibilityTree = null;
      }
    }

    const landmarks = await accessPage.evaluate(() => {
      const roles = ['banner', 'navigation', 'main', 'contentinfo', 'complementary', 'search', 'form'];
      const found = {};
      roles.forEach(role => {
        found[role] = document.querySelectorAll(`[role="${role}"]`).length;
      });
      found.header = document.querySelectorAll('header').length;
      found.nav = document.querySelectorAll('nav').length;
      found.mainEl = document.querySelectorAll('main').length;
      found.footer = document.querySelectorAll('footer').length;
      return found;
    });
    manifest.landmarks = landmarks;

    await accessContext.close();

    // Phase 3: CTA Funnel Mapping
    if (opts.funnel) {
      console.error('[funnel] Mapping CTA destinations...');
      manifest.ctaFunnel = await mapCTAFunnel(browser, url, opts.outputDir);
      console.error(`[funnel] Mapped ${manifest.ctaFunnel.length} CTAs`);
    }

    // Phase 4: Multi-Page Flow
    if (opts.flow) {
      let flowSteps;
      try {
        // Try parsing as JSON directly, or as a file path
        if (opts.flow.startsWith('[')) {
          flowSteps = JSON.parse(opts.flow);
        } else if (existsSync(opts.flow)) {
          flowSteps = JSON.parse(readFileSync(opts.flow, 'utf-8'));
        } else {
          throw new Error(`Invalid --flow value: not JSON and not a file path`);
        }
      } catch (err) {
        console.error(`[flow] Error parsing flow: ${err.message}`);
        manifest.flowResults = [{ error: err.message }];
        flowSteps = null;
      }

      if (flowSteps) {
        const agentMailEmail = opts.signup && manifest.signupFlow?.email
          ? manifest.signupFlow.email
          : null;
        console.error(`[flow] Running ${flowSteps.length} steps...`);
        manifest.flowResults = await runFlow(browser, url, flowSteps, opts.outputDir, agentMailEmail);
        console.error(`[flow] Completed ${manifest.flowResults.length} steps`);
      }
    }

    // Phase 5: Signup Flow with AgentMail
    if (opts.signup) {
      if (!opts.agentmailKey) {
        console.error('[signup] No AgentMail API key provided. Set AGENTMAIL_API_KEY or use --agentmail-key');
        manifest.signupFlow = { error: 'No AgentMail API key provided' };
      } else {
        console.error('[signup] Starting signup flow test...');
        manifest.signupFlow = await testSignupFlow(browser, url, opts.outputDir, opts.agentmailKey);
        console.error(`[signup] Complete. Confirmation received: ${manifest.signupFlow.confirmationReceived}`);
      }
    }

  } finally {
    await browser.close();
  }

  // Write manifest
  const manifestPath = `${opts.outputDir}/manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Output manifest path for Claude to read
  console.log(JSON.stringify({
    manifestPath,
    outputDir: opts.outputDir,
    captureCount: manifest.captures.length,
    ctaCount: manifest.ctaFunnel.length,
    flowSteps: manifest.flowResults.length,
    signupTested: !!manifest.signupFlow?.formSubmitted,
  }));
}

main().catch(err => {
  console.error('Capture failed:', err.message);
  process.exit(1);
});
