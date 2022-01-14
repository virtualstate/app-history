/* c8 ignore start */
import * as Playwright from "playwright";
import { h } from "@virtualstate/fringe";
import {deferred} from "../util/deferred";
import fs from "fs";
import path from "path";
import {getConfig} from "./config";
import * as Cheerio from "cheerio";
import {DependenciesHTML, DependenciesSyncHTML} from "./dependencies";
import {Browser, Page} from "playwright";
import {v4} from "uuid";
import {createJavaScriptBundle} from "./app-history.server.wpt";

const namespacePath = "/node_modules/wpt/app-history";
const namespaceBundlePath = "/app-history";
const buildPath = "/esnext";
const resourcesInput = "/resources";
const resourcesTarget = "/node_modules/wpt/resources";
const testWrapperFnName = `tests${v4().replace(/[^a-z0-9]/g, "")}`

console.log({ testWrapperFnName });

const DEBUG = getConfig().FLAGS?.includes("DEBUG") || false;
const DEVTOOLS = getConfig().FLAGS?.includes("DEVTOOLS") || false;
const ONLY_FAILED = getConfig().FLAGS?.includes("ONLY_FAILED") || false;
const INCLUDE_SERVICE_WORKER = getConfig().FLAGS?.includes("INCLUDE_SERVICE_WORKER") || false;
const AT_A_TIME = +(getConfig().AT_A_TIME ?? (DEBUG ? 1 : 60));
const TEST_RESULTS_PATH = "./node_modules/.wpt.test-results.json";
const ONLY = getConfig().ONLY;
const DEVTOOLS_SLOW_MO: number | undefined = undefined;
const browsers = [
    ["chromium", Playwright.chromium, { esm: true, args: [], FLAG: "" }] as const,
] as const


// webkit and firefox do not support importmap
for (const [browserName, browserLauncher, { esm, args, FLAG }] of browsers.filter(([, browser]) => browser)) {

    if (FLAG && !getConfig().FLAGS?.includes(FLAG)) {
        continue;
    }

    const browser = await browserLauncher.launch({
        headless: !DEVTOOLS,
        devtools: DEVTOOLS,
        args: [
            ...args
        ],
        slowMo: DEVTOOLS ? DEVTOOLS_SLOW_MO : undefined
    });

    console.log(`Running WPT playwright tests for ${browserName} ${browser.version()}`)

    const types = (await fs.promises.readdir(`.${namespacePath}`)).filter(value => !value.includes("."));

    let urls = [
        ...(await Promise.all(
            types.map(async type => {
                return (
                    await fs.promises.readdir(`.${namespacePath}/${type}`)
                )
                    .filter(value => value.endsWith(".html"))
                    .map(value => `/${type}/${value}`)
            })
        ))
            .flatMap(value => value)
    ];

    if (!ONLY && DEBUG) {
        // urls = urls.slice(0, 3);
        urls = urls.filter(url => url.includes("transitionWhile"));
    }

    console.log("STARTING:");
    urls.forEach(url => console.log(`  - ${url}`));

    let total = 0,
        pass = 0,
        fail = 0,
        // TODO use coverage trace to ensure this scripts lines are fully executed
        linesTotal = 0,
        linesPass = 0,
        linesPassCovered = 0,
        urlsPass: string[] = [],
        urlsFailed: string[] = [],
        urlsSkipped: string[] = [];

    if (ONLY) {
        console.log(ONLY);
        // urlsSkipped.push(...urls.filter(url => url !== ONLY))
        urls = urls.filter(url => url === ONLY);
    } else if (ONLY_FAILED) {
        const state = await readState();
        if (Array.isArray(state.urlsFailed)) {
            urls = state.urlsFailed;
            if (Array.isArray(state.urlsPass)) {
                urlsPass.push(...state.urlsPass);
            }
        }
    }

    if (!INCLUDE_SERVICE_WORKER && !ONLY) {
        urlsSkipped.push(...urls.filter(url => url.includes("service-worker")))
        urls = urls.filter(url => !url.includes("service-worker"));
    }

    let result = {};

    while (urls.length) {
        await Promise.all(
            Array.from({ length: AT_A_TIME }, () => urls.shift())
                .filter(Boolean)
                .map(async url => {
                    await withUrl(url);
                    result = {
                        total,
                        pass,
                        fail,
                        percent: Math.round(pass / total * 100 * 100) / 100,
                        linesTotal,
                        linesPass,
                        linesPassCovered,
                        percentLines: Math.round(linesPass / linesTotal * 100 * 100) / 100,
                        percentLinesCovered: Math.round(linesPassCovered / linesTotal * 100 * 100) / 100,
                        percentLinesCoveredMatched: Math.round(linesPassCovered / linesPass * 100 * 100) / 100
                    };
                    console.log(result);
                })
        );
    }

    await fs.promises.writeFile("./coverage/wpt.results.json", JSON.stringify(result));
    await browser.close();

    console.log("Playwright tests complete");

    console.log("PASSED:");
    urlsPass.forEach(url => console.log(`  - ${url}`));
    console.log("\nFAILED:");
    urlsFailed.forEach(url => console.log(`  - ${url}`));
    if (urlsSkipped.length) {
        console.log("\nSKIPPED:");
        urlsSkipped.forEach(url => console.log(`  - ${url}`));
    }

    await writeState({
        urlsPass,
        urlsFailed
    });

    async function writeState(state: Record<string, unknown>) {
        await fs.promises.writeFile(TEST_RESULTS_PATH, JSON.stringify(state, undefined, "  "));
    }

    async function readState() {
        return fs.promises.readFile(TEST_RESULTS_PATH, "utf-8").then(JSON.parse).catch(() => ({}));
    }

    async function withUrl(url: string) {
        total += 1;
        const context = await browser.newContext({});
        const page = await context.newPage();
        try {
            console.log(`START ${url}`);

            const html = await fs.promises.readFile(`.${namespacePath}/${url}`, 'utf-8');
            const $ = Cheerio.load(html);
            const lines = $("script:not([src])").html()?.split('\n').length ?? 0;
            linesTotal += lines;

            await page.coverage.startJSCoverage();

            await run(browserName, browser, page, url);

            const coverage = await page.coverage.stopJSCoverage();

            const matchingFnEntry = coverage.find(entry => entry.functions.find(fn => fn.functionName === testWrapperFnName));
            const matchingFn = matchingFnEntry.functions.find(fn => fn.functionName === testWrapperFnName);

            const code = matchingFn.ranges
                .filter(range => range.count > 0)
                .map(range => matchingFnEntry.source.slice(range.startOffset, range.endOffset))
                .join('');

            // Minus 2 because this code includes the function definition, start bracket, and end bracket
            const coveredLines = code.split('\n').length - 2;

            // console.log(code.split('\n').length);

            console.log(`PASS  ${url} : ${lines} Lines`);
            urlsPass.push(url);
            pass += 1;
            linesPass += lines;
            linesPassCovered += coveredLines;

        } catch (error) {
            console.log(`FAIL  ${url}`, error);
            fail += 1;
            urlsFailed.push(url);
        }
        await page.close();
        await context.close();
    }
}

console.log(`PASS assertAppHistory:playwright:new AppHistory`);

async function run(browserName: string, browser: Browser, page: Page, url: string) {

    const { resolve, reject, promise } = deferred<void>();

    void promise.catch(error => error);

    await page.exposeFunction("testsComplete", (details: unknown) => {
        console.log(`Playwright tests complete tests for ${browserName} ${browser.version()}`, details)
        return resolve();
    });
    await page.exposeFunction("testsFailed", (reason: unknown) => {
        console.log(`Playwright tests failed tests for ${browserName} ${browser.version()}`, reason);
        return reject(reason);
    });

    if (DEBUG) {
        page.on('console', console.log);
    } else {
        // you can comment out this one :)
        page.on('console', console.log);
    }

    await page.route('**/*', async (route, request) => {
        const routeUrl = new URL(request.url());
        const { pathname } = routeUrl;

        if (pathname.endsWith("foo.html")) {
            return route.abort();
        }

        // console.log({ pathname, isResources: pathname.startsWith(resourcesInput), isBundle: pathname.startsWith(namespaceBundlePath) && pathname.endsWith(".html.js") });
        if (pathname.startsWith(namespaceBundlePath) && pathname.endsWith(".html.js")) {
            const contents = await createJavaScriptBundle(routeUrl);
            return route.fulfill({
                body: contents,
                headers: {
                    "Content-Type": "application/javascript",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        } else if (pathname.startsWith(namespacePath) || pathname.startsWith(resourcesInput) || pathname.startsWith(buildPath)) {
            const { pathname: file } = new URL(import.meta.url);
            let input = pathname.startsWith(resourcesInput) ? pathname.replace(resourcesInput, resourcesTarget) : pathname;
            let importTarget = path.resolve(path.join(path.dirname(file), '../..', input));
            if (!/\.[a-z]+$/.test(importTarget)) {
                // console.log({ importTarget });
                if (!importTarget.endsWith("/")) {
                    importTarget += "/";
                }
                importTarget += "index.js";
            }
            // console.log({ importTarget });
            let contents = await fs.promises.readFile(importTarget, "utf-8").catch(() => "");

            if (!contents) {
                return route.abort();
            }

            // console.log({ importTarget, contents: !!contents });
            let contentType = "application/javascript";
            if (importTarget.endsWith(".html")) {
                contentType = "text/html";

                const html = await fs.promises.readFile(importTarget, "utf-8").catch(() => "");
                const $ = Cheerio.load(html);

                const globalNames = [
                    "appHistory",
                    "window",
                    "i",
                    "iframe",
                    "location",
                    "history",
                    "promise_test",
                    "test",
                    "test_driver",
                    // "assert_true",
                    // "assert_false",
                    // "assert_equals",
                    // "assert_not_equals",
                    // "assert_unreached",
                    "async_test",
                    "promise_rejects_dom",
                    "a",
                    "form",
                    "submit",
                ]

                const targetUrl = `${namespaceBundlePath}${url}.js?exportAs=${testWrapperFnName}&globals=${globalNames.join(",")}`;

                // console.log({ targetUrl, namespacePath, url })
                const scriptText = `
globalThis.rv = [];

const { ${testWrapperFnName} } = await import("${targetUrl}&preferUndefined=1&debugger=${DEVTOOLS ? "1" : ""}");

const { 
  AppHistory, 
  InvalidStateError, 
  AppHistoryTransitionFinally, 
  AppHistorySync, 
  EventTarget, 
  AppHistoryUserInitiated, 
  AppHistoryFormData
  } = await import("/esnext/index.js");

// if (${DEVTOOLS}) {
//   await new Promise(resolve => setTimeout(resolve, 2500));
// }

let appHistoryTarget = new AppHistory();

function proxyAppHistory(appHistory, get) {
  return new Proxy(appHistory, {
    get(u, property) {
      const currentTarget = get();
      const value = currentTarget[property];
      if (typeof value === "function") return value.bind(currentTarget);
      return value;
    }
  });
}

const appHistory = proxyAppHistory(appHistoryTarget, () => appHistoryTarget);
const location = (
  new AppHistorySync({
    appHistory
  })
),
  history = location;
globalThis.appHistory = appHistory;

appHistory.addEventListener("navigateerror", console.error);

async function navigateFinally(appHistory, url) {
    // This allows us to wait for the navigation to fully settle before starting 
    const initialNavigationFinally = new Promise((resolve) => appHistory.addEventListener(AppHistoryTransitionFinally, resolve, { once: true }));
    
    // Initialise first navigation to emulate a page loaded
    await appHistory.navigate(url).finished;
    
    await initialNavigationFinally;
}
await navigateFinally(appHistoryTarget, "/");

const Event = CustomEvent;
const windowEvents = new EventTarget();
let firstLoad = false;
const window = {
  set onload(value) {
    if (!firstLoad) {
      console.log("first window onload");
      value();
      firstLoad = false;
    } else {
      console.log("next window onload");
      windowEvents.addEventListener("load", value, { once: true });
    }
  },
  appHistory,
  stop() {
    if (appHistory.transition) {
      return appHistory.transition.rollback();
    }
  }
};

let iframeAppHistoryTarget = new AppHistory();
const iframeAppHistory = proxyAppHistory(iframeAppHistoryTarget, () => iframeAppHistoryTarget);
await navigateFinally(iframeAppHistoryTarget, "/");
const iframeLocation = (
  new AppHistorySync({
    appHistory
  })
),
  iframeHistory = iframeLocation;
const iframeEvents = new EventTarget();
const iframe = {
  contentWindow: {
    appHistory: iframeAppHistory,
    DOMException: InvalidStateError,
    history: iframeHistory,
    location: iframeLocation,
    set onload(value) {
      iframeEvents.addEventListener("load", value, { once: true });
    },
  },
  remove() {
    iframeAppHistoryTarget = new AppHistory();
  },
  set onload(value) {
    iframeEvents.addEventListener("load", (e) => {
      console.log("load", e);
      return value(e)
    }, { once: true });
  },
  set src(value) {
    run().then(() => console.log("navigated")).catch(console.log)
  
    async function run() {
      const url = value.toString();
      await iframe.contentWindow.appHistory.navigate(url)
        .finished;
    }
  }
};
const i = iframe;

const testSteps = [];

// Wait for all navigations to settle
appHistory.addEventListener("currentchange", () => {
  const finished = appHistory.transition?.finished;
  if (finished) {
    testSteps.push(async () => {
      try {
        await finished;
      } catch {}
    });
  }
})
iframe.contentWindow.appHistory.addEventListener("navigate", () => {
  console.log("navigate iframe");
  const handler = (e) => {
    if (e.type === "navigatesuccess") { 
        console.log("dispatch load");
        iframeEvents.dispatchEvent({ type: "load" });
    } else {
        console.log("dispatch error");
        iframeEvents.dispatchEvent({ type: "error" });
    }
    iframe.contentWindow.appHistory.removeEventListener("navigatesuccess", handler, { once: true });
    iframe.contentWindow.appHistory.removeEventListener("navigateerror", handler, { once: true });
  }
  iframe.contentWindow.appHistory.addEventListener("navigatesuccess", handler, { once: true });
  iframe.contentWindow.appHistory.addEventListener("navigateerror", handler, { once: true });
})

window.open = (url, target) => {
  if (target === "i" || target === "iframe") {
    return iframe.contentWindow.appHistory.navigate(url);
  }
}


const a = new EventTarget();
a.href = ${JSON.stringify($("a[href]")?.attr("href") || "#1")};
a.click = (e) => {
  let targetAppHistory = appHistory,
    targetLocation = location;
  return targetAppHistory.navigate(new URL(a.href, targetLocation.href).toString(), e);
}

const form = new EventTarget();
form.action = ${JSON.stringify($("form[action]")?.attr("action") || "")};
form.method = ${JSON.stringify($("form[method]")?.attr("method") || "post")};
form.target = ${JSON.stringify($("form[target]")?.attr("target") || "")};
form.submit = (e) => {
  let targetAppHistory = appHistory,
    targetLocation = location;
  if (form.target === "i" || form.target === "iframe") {
    targetAppHistory = iframe.contentWindow.appHistory;
    targetLocation = iframe.contentWindow.location;
  }
  const action = form.action ? new URL(form.action, targetLocation.href).toString() : targetLocation.href;
  return targetAppHistory.navigate(action, {
    ...e,
    [AppHistoryFormData]: new FormData()
  });
}

const submit = new EventTarget();
submit.type = "submit";
submit.click = (e) => {
  return form.submit(e);
}

const details = {
  tests: 0,
  assert_true: 0,
  assert_false: 0,
  assert_equals: 0,
  assert_not_equals: 0,
  step_timeout: 0,
  step_func: 0,
  step_func_done: 0,
  promise_rejects_dom: 0,
  done: 0,
  unreached_func: 0
}

function promise_test(fn) {
  testSteps.push(fn);
  details.tests += 1;
}
function async_test(fn) {
  testSteps.push(fn);
  details.tests += 1;
}
function test(fn) {
  testSteps.push(fn);
  details.tests += 1;
}
function assert_true(value, message = "Expected true") {
  details.assert_true += 1;
  // console.log(value);
  if (value !== true) {
    throw new Error(message);
  }
}
function assert_false(value, message = "Expected false") {
  details.assert_false += 1;
  // console.log(value);
  if (value !== false) {
    throw new Error(message);
  }
}
function assert_equals(left, right) {
  details.assert_equals += 1;
  // console.log(JSON.stringify({ left, right }));
  if (left !== right) {
    throw new Error("Expected values to equal");
  }
}
function assert_not_equals(left, right) {
  details.assert_not_equals += 1;
  // console.log(JSON.stringify({ left, right }));
  if (left === right) {
    throw new Error("Expected values to not equal");
  }
}

async function promise_rejects_dom(test, name, promise) {
  details.promise_rejects_dom += 1;
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (!caught) {
    throw new Error("Expected promise rejection");
  }
}

function assert_unreached() {
  const error = new Error("Did not expect to reach here");
  testSteps.push(() => Promise.reject(error));
  throw error;
}

const t = {
  step_timeout(resolve, timeout) {
    details.step_timeout += 1;
    setTimeout(resolve, timeout);  
  },
  step_func(fn) {
    details.step_func += 1;
    let resolve, reject;
    const promise = new Promise((resolveFn, rejectFn) => { resolve = resolveFn; reject = rejectFn; });
    testSteps.push(() => promise);
    return (...args) => {
      try {
        const result = fn(...args);
        if (result && typeof result === "object" && "then" in result) {
           return result.then(resolve, reject).then(() => result);
        } else {
           resolve();
        }
        return result;
      } catch (error) {
        reject(error);
        throw error;
      }
    }
  },
  step_func_done(fn) {
    details.step_func_done += 1;
    return t.step_func(fn);
  },
  done(fn) {
    details.done += 1;
    return t.step_func(fn);
  },
  unreached_func(message) {
    details.unreached_func += 1;
    return () => tests.push(() => Promise.reject(new Error(message)));
  }
}

const test_driver = {
  click(element) {
    return element.click({
      [AppHistoryUserInitiated]: true
    });
  }
}

console.log("Starting tests");

await ${testWrapperFnName}({
  ${globalNames.join(",\n")}
});

if (!testSteps.length) {
  console.error("No tests configured");
  globalThis.window.testsFailed("No tests configured");
} else {
  try {
    await Promise.all(testSteps.map(async test => test(t)));
    if (${DEVTOOLS}) console.log("PASS");
    globalThis.window.testsComplete(JSON.stringify(details));
  } catch (error) {
    if (${DEVTOOLS}) console.log("FAIL", error);
    globalThis.window.testsFailed(error.toString() + " " + error.stack);
    throw error;
  }
}
                
                `.trim();
                contents = `
${DependenciesSyncHTML}
<script type="module">${scriptText}</script>
                `.trim()
                //
                // console.log(contents);
            }


            return route.fulfill({
                body: contents,
                headers: {
                    "Content-Type": contentType,
                    "Access-Control-Allow-Origin": "*"
                }
            });
        }

        return route.continue();
    })

    await page.goto(`https://example.com${namespacePath}${url}`, {

    });

    // console.log("Navigation started");

    await page.waitForLoadState("load");

    // console.log("Loaded document");

    await page.waitForLoadState("networkidle");

    // console.log("Network idle");

    setTimeout(reject, 30000, new Error("Timeout"));

    try {
        await promise;
    } finally {
        if (DEVTOOLS) {
            await new Promise(() => void 0);
            // await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}
/* c8 ignore end */