import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Run through the allowed CUA environment, passing its documented tab and viewport handles.
export async function validateLayout(tab, viewport, directory) {
  await mkdir(directory, { recursive: true });
  const results = [];
  for (const size of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 390, height: 844 },
  ]) {
    await viewport.set(size);
    for (const theme of ["light", "dark"]) {
      if (
        await tab.playwright
          .getByRole("button", { name: `Switch to ${theme} mode`, exact: true })
          .count()
      ) {
        await tab.playwright
          .getByRole("button", { name: `Switch to ${theme} mode`, exact: true })
          .click();
        await tab.getAXState({ emit: false });
      }
      for (const name of ["Overview", "Messages", "Map", "Chart"]) {
        await tab.playwright
          .getByRole("tab", { name: new RegExp(`^${name}(?: |$)`) })
          .click();
        await tab.getAXState({ emit: false });
        if (name === "Messages") {
          await tab.playwright.getByRole("tab", { name: /^Record / }).click();
          await tab.getAXState({ emit: false });
        }
        if (name === "Map")
          await tab.playwright
            .locator(".leaflet-tile-loaded")
            .first()
            .waitFor({ state: "visible" });
        if (name === "Chart")
          await tab.playwright
            .locator(".recharts-line-curve")
            .first()
            .waitFor({ state: "visible" });
        const actual = await tab.playwright.evaluate(() => {
          const panel = document.querySelector(
            '[role="tabpanel"]:not([hidden])',
          );
          const map = panel?.querySelector(".leaflet-container");
          const route = map?.querySelector(
            '.leaflet-overlay-pane path[fill="none"]',
          );
          const routeBounds = route?.getBoundingClientRect();
          const overview = panel?.querySelector(
            ".section-view:not([hidden]) .overview-content",
          );
          const charts = panel?.querySelector(
            ".section-view:not([hidden]) .viewer-chart-workspace",
          );
          const sensorList = charts?.querySelector(".viewer-sensor-list");
          const plots = charts?.querySelector(".viewer-chart-plots");
          return {
            width: innerWidth,
            height: innerHeight,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            rows: panel?.querySelectorAll("tbody tr").length ?? 0,
            footers: document.querySelectorAll("footer").length,
            mapHeight: map?.getBoundingClientRect().height ?? 0,
            mapRoute: routeBounds
              ? {
                  width: routeBounds.width,
                  height: routeBounds.height,
                  left: routeBounds.left,
                  right: routeBounds.right,
                  top: routeBounds.top,
                  bottom: routeBounds.bottom,
                }
              : null,
            mapBounds: map
              ? {
                  left: map.getBoundingClientRect().left,
                  right: map.getBoundingClientRect().right,
                  bottom: map.getBoundingClientRect().bottom,
                }
              : null,
            overviewWidth: overview?.getBoundingClientRect().width,
            panelWidth: panel?.getBoundingClientRect().width,
            chartBottom: charts?.getBoundingClientRect().bottom,
            sensorListBottom: sensorList?.getBoundingClientRect().bottom,
            plotAreaBottom: plots?.getBoundingClientRect().bottom,
            mapTiles: map?.querySelectorAll(".leaflet-tile-loaded").length ?? 0,
            attribution: map?.querySelector(".leaflet-control-attribution")
              ?.textContent,
            chartPaths:
              panel?.querySelectorAll(".recharts-line-curve").length ?? 0,
            controls: Array.from(
              panel?.querySelectorAll("button,input,select") ?? [],
            )
              .filter((e) => e.getBoundingClientRect().width > 0)
              .map((e) => ({
                label: e.getAttribute("aria-label") ?? e.textContent,
                width: e.getBoundingClientRect().width,
              })),
          };
        });
        assert.equal(actual.width, size.width);
        assert.equal(actual.height, size.height);
        assert.equal(
          actual.scrollWidth,
          size.width,
          `${theme} ${name} horizontal page overflow`,
        );
        assert.equal(
          actual.scrollHeight,
          size.height,
          `${theme} ${name} vertical page overflow`,
        );
        assert.equal(actual.footers, 0);
        if (name === "Messages") assert.equal(actual.rows, 20);
        if (name === "Overview")
          assert.equal(actual.overviewWidth, actual.panelWidth);
        if (name === "Map") {
          assert.ok(
            actual.mapRoute?.width > 0 && actual.mapRoute?.height > 0,
            `${theme} ${size.width} route is not rendered`,
          );
          assert.ok(
            actual.mapRoute.right > actual.mapBounds.left &&
              actual.mapRoute.left < actual.mapBounds.right &&
              actual.mapRoute.bottom > size.height - actual.mapHeight &&
              actual.mapRoute.top < actual.mapBounds.bottom,
            `${theme} ${size.width} route is outside the map`,
          );
          assert.ok(actual.mapHeight > size.height * 0.65);
          assert.ok(actual.mapTiles > 0);
          assert.match(actual.attribution, /OpenStreetMap/);
          assert.equal(actual.mapBounds.left, 0);
          assert.equal(actual.mapBounds.right, size.width);
          assert.equal(actual.mapBounds.bottom, size.height);
        }
        if (name === "Chart") {
          assert.ok(actual.chartPaths > 0);
          assert.equal(actual.chartBottom, size.height);
          assert.equal(actual.plotAreaBottom, size.height);
          if (size.width >= 760)
            assert.equal(actual.sensorListBottom, size.height);
        }
        results.push({ size, theme, tab: name, ...actual });
        await writeFile(
          resolve(
            directory,
            `${size.width}-${theme}-${name.toLowerCase()}.png`,
          ),
          await tab.screenshot({ clip: { x: 0, y: 0, ...size } }),
        );
      }
    }
  }
  await writeFile(
    resolve(directory, "matrix.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  return results;
}

export async function validateCombined(tab, viewport, directory) {
  await mkdir(directory, { recursive: true });
  await tab.playwright.getByRole("tab", { name: /^Messages/ }).click();
  await tab.getAXState({ emit: false });
  await tab.playwright
    .getByRole("tab", { name: /^Single-entry messages/ })
    .click();
  await tab.getAXState({ emit: false });
  const results = [];
  for (const size of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 390, height: 844 },
  ]) {
    await viewport.set(size);
    for (const theme of ["light", "dark"]) {
      const toggle = tab.playwright.getByRole("button", {
        name: `Switch to ${theme} mode`,
        exact: true,
      });
      if (await toggle.count()) await toggle.click();
      await tab.getAXState({ emit: false });
      const actual = await tab.playwright.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        footers: document.querySelectorAll("footer").length,
        tables: Array.from(
          document.querySelectorAll(".single-entry-section table"),
        ).map((table) => ({
          headers: table.querySelectorAll("thead tr").length,
          values: table.querySelectorAll("tbody tr").length,
          columns: table.querySelectorAll("thead th").length,
          cells: table.querySelectorAll("tbody td").length,
        })),
      }));
      assert.equal(actual.scrollWidth, size.width);
      assert.equal(actual.scrollHeight, size.height);
      assert.equal(actual.footers, 0);
      assert.ok(actual.tables.length > 1);
      for (const table of actual.tables) {
        assert.equal(table.headers, 1);
        assert.equal(table.values, 1);
        assert.equal(table.columns, table.cells);
      }
      results.push({ size, theme, ...actual });
      await writeFile(
        resolve(directory, `${size.width}-${theme}-combined.png`),
        await tab.screenshot({ clip: { x: 0, y: 0, ...size } }),
      );
    }
  }
  await writeFile(
    resolve(directory, "combined.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  return results;
}

export async function validateOverview(tab, viewport, directory) {
  await mkdir(directory, { recursive: true });
  await tab.playwright
    .getByRole("tab", { name: "Overview", exact: true })
    .click();
  await tab.getAXState({ emit: false });
  const results = [];
  for (const size of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 390, height: 844 },
  ]) {
    await viewport.set(size);
    for (const theme of ["light", "dark"]) {
      const themeButton = tab.playwright.getByRole("button", {
        name: `Switch to ${theme} mode`,
        exact: true,
      });
      if (await themeButton.count()) await themeButton.click();
      const nextTheme = theme === "light" ? "dark" : "light";
      await tab.playwright
        .getByRole("button", {
          name: `Switch to ${nextTheme} mode`,
          exact: true,
        })
        .press("Shift+Tab");
      await tab.getAXState({ emit: false });
      const actual = await tab.playwright.evaluate(() => {
        const metrics = document.querySelector(".viewer-metrics");
        const details = document.querySelector(".viewer-file-details");
        const tooltip = document.querySelector("#developer-mode-help");
        const bounds = tooltip.getBoundingClientRect();
        return {
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          metrics: Array.from(
            metrics.querySelectorAll("dt"),
            (e) => e.textContent,
          ),
          details: Array.from(
            details.querySelectorAll("dt"),
            (e) => e.textContent,
          ),
          timestamps: Array.from(metrics.querySelectorAll("time"), (e) =>
            e.getAttribute("datetime"),
          ),
          duration: metrics.querySelector(".viewer-metric-duration dd")
            .textContent,
          hourlySize: details.textContent,
          statusBanners: document.querySelectorAll(
            ".overview-content .viewer-status",
          ).length,
          viewMessages: Array.from(document.querySelectorAll("button")).some(
            (e) => e.textContent.trim() === "View messages",
          ),
          overflowingMetrics: Array.from(metrics.querySelectorAll("dd")).filter(
            (e) => e.scrollWidth > e.clientWidth + 1,
          ).length,
          tooltip: {
            visible: getComputedStyle(tooltip).visibility === "visible",
            description: tooltip.textContent.trim(),
            describedBy:
              document.activeElement.getAttribute("aria-describedby"),
            role: document.activeElement.getAttribute("role"),
            left: bounds.left,
            right: bounds.right,
            bottom: bounds.bottom,
          },
        };
      });
      assert.equal(actual.scrollWidth, size.width);
      assert.equal(actual.scrollHeight, size.height);
      assert.equal(
        JSON.stringify(actual.metrics),
        JSON.stringify([
          "Start - end time",
          "Duration",
          "Messages",
          "GPS points",
          "Sessions",
        ]),
      );
      assert.ok(actual.details.includes("File size"));
      assert.ok(actual.details.includes("Size per hour"));
      for (const removed of ["Manufacturer", "Product", "Start time"])
        assert.ok(!actual.details.includes(removed));
      assert.equal(actual.timestamps.length, 2);
      assert.equal(
        Date.parse(actual.timestamps[1]) - Date.parse(actual.timestamps[0]),
        179000,
      );
      assert.equal(actual.duration, "00:02:59");
      assert.ok(
        actual.hourlySize.includes(
          Math.round((9743 * 3600) / 179).toLocaleString(),
        ),
      );
      assert.equal(actual.statusBanners, 0);
      assert.equal(actual.viewMessages, false);
      assert.equal(actual.overflowingMetrics, 0);
      assert.equal(actual.tooltip.visible, true);
      assert.equal(actual.tooltip.role, "switch");
      assert.equal(actual.tooltip.describedBy, "developer-mode-help");
      assert.ok(actual.tooltip.description.includes("raw recorded values"));
      assert.ok(
        actual.tooltip.description.includes("Does not modify the FIT file"),
      );
      assert.ok(actual.tooltip.left >= 0 && actual.tooltip.right <= size.width);
      assert.ok(actual.tooltip.bottom <= size.height);
      results.push({ size, theme, ...actual });
      await writeFile(
        resolve(directory, `${size.width}-${theme}-overview-tooltip.png`),
        await tab.screenshot({ clip: { x: 0, y: 0, ...size } }),
      );
      await tab.playwright
        .getByRole("switch", { name: "Developer Mode", exact: true })
        .press("Tab");
      await tab.getAXState({ emit: false });
      assert.equal(await tab.playwright.getByRole("tooltip").count(), 0);
    }
  }
  await writeFile(
    resolve(directory, "overview.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  return results;
}
