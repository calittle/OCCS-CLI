import path from 'path';
import { loadSession } from './session.js';
import { paginate } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment, mapWithConcurrency } from './utils.js';
import { activeVersions, findArtifactByShortName } from './artifactLookup.js';
import { createArtifactFailureReport, getArtifact } from './artifactFailures.js';
import { resumeArtifact } from './exportResume.js';

const CHART_API = '/api/Chart/v1';

function chartSummary(item) {
  const rec = item.ChartConfigRec || item;
  return { shortName: rec.ChartConfigInfo?.ShortName, uuid: rec.ChartConfigUuid };
}

function nestedUuid(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

async function saveArtifact(session, endpoint, directory, fileName, verbose, report) {
  const artifact = await getArtifact(session, endpoint, { depth: true }, verbose, report);
  if (artifact) writeJSON(path.join(directory, fileName), artifact);
  return artifact;
}

async function saveSeriesArtifacts(session, version, versionDir, verbose, report) {
  const plotSeries = version?.ChartVersionPlot?.ChartPlotSeries || [];
  const seriesDir = path.join(versionDir, 'series');

  let complete = true;
  for (const relation of plotSeries) {
    const uuid = nestedUuid(relation, ['ChartPlotConfigChartSeriesConfigRelRec', 'ChartPlotConfigChartSeriesConfigRelInfo', 'ChartSeriesConfigUuid']);
    if (!uuid) continue;

    ensureDir(seriesDir);
    const series = await saveArtifact(session, `${CHART_API}/ChartSeriesMasterConfig/${uuid}`, seriesDir, `${uuid}.json`, verbose, report);
    if (!series) { complete = false; continue; }

    const categoryUuid = nestedUuid(series, ['ChartSeriesCategory', 'ChartSeriesConfigChartCategoryConfigRelRec', 'ChartSeriesConfigChartCategoryConfigRelInfo', 'ChartCategoryConfigUuid']);
    if (categoryUuid) {
      const categoryDir = path.join(versionDir, 'categories');
      ensureDir(categoryDir);
      const category = await saveArtifact(session, `${CHART_API}/ChartCategoryMasterConfig/${categoryUuid}`, categoryDir, `${categoryUuid}.json`, verbose, report);
      if (!category) { complete = false; continue; }
      const categoryAxisUuid = nestedUuid(category, ['ChartCategoryAxis', 'ChartCategoryConfigChartCategoryAxisConfigRelRec', 'ChartCategoryConfigChartCategoryAxisConfigRelInfo', 'ChartCategoryAxisConfigUuid']);
      if (categoryAxisUuid) {
        const axisDir = path.join(versionDir, 'category-axes');
        ensureDir(axisDir);
        if (!await saveArtifact(session, `${CHART_API}/ChartCategoryAxisMasterConfig/${categoryAxisUuid}`, axisDir, `${categoryAxisUuid}.json`, verbose, report)) complete = false;
      }
    }

    const seriesAxisUuid = nestedUuid(series, ['ChartSeriesAxis', 'ChartSeriesConfigChartSeriesAxisConfigRelRec', 'ChartSeriesConfigChartSeriesAxisConfigRelInfo', 'ChartSeriesAxisConfigUuid']);
    if (seriesAxisUuid) {
      const axisDir = path.join(versionDir, 'series-axes');
      ensureDir(axisDir);
      if (!await saveArtifact(session, `${CHART_API}/ChartSeriesAxisMasterConfig/${seriesAxisUuid}`, axisDir, `${seriesAxisUuid}.json`, verbose, report)) complete = false;
    }

    const annotations = series.ChartSeriesAnnotations || [];
    for (const annotation of annotations) {
      const annotationUuid = nestedUuid(annotation, ['ChartSeriesConfigChartAnnotationConfigRelRec', 'ChartSeriesConfigChartAnnotationConfigRelInfo', 'ChartAnnotationConfigUuid']);
      if (!annotationUuid) continue;
      const annotationDir = path.join(versionDir, 'annotations');
      ensureDir(annotationDir);
      if (!await saveArtifact(session, `${CHART_API}/ChartAnnotationMasterConfig/${annotationUuid}`, annotationDir, `${annotationUuid}.json`, verbose, report)) complete = false;
    }
  }
  return complete;
}

export async function listChartsCommand(cmd) {
  console.log("(>'-')> Charting chartifacts...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/charts';
  if (cmd.exportResume?.resumed) ensureDir(outputDir); else setDir(outputDir);

  const charts = await paginate(
    session,
    `${CHART_API}/ChartConfigRec`,
    { depth: true, summary: true, totalResults: true },
    49,
    cmd.verbose
  );

  const report = createArtifactFailureReport();
  const results = await mapWithConcurrency(charts, cmd.concurrency ?? 4, async (item) => {
    const record = item.ChartConfigRec || item;
    const uuid = record.ChartConfigUuid;
    const shortName = record.ChartConfigInfo?.ShortName || uuid;
    if (!uuid) return { ok: false };
    return resumeArtifact(cmd.exportResume, 'charts', uuid, item, path.join(outputDir, safePathSegment(shortName)), async () => {
      return downloadChart(session, item, outputDir, cmd.verbose, false, report);
    });
  });

  console.log(`✅ Saved ${charts.length} charts to ${outputDir}`);
  report.print();
  return { ok: report.count === 0 && results.every((result) => result?.ok), skipped: results.filter((result) => result?.skipped).length };
}

async function downloadChart(session, item, outputDir, verbose, onlyActiveVersions = false, report) {
    const record = item.ChartConfigRec || item;
    const info = record.ChartConfigInfo || {};
    const uuid = record.ChartConfigUuid;
    if (!uuid) return false;

    const shortName = safePathSegment(info.ShortName || uuid);
    const chartDir = path.join(outputDir, shortName);
    ensureDir(chartDir);
    writeJSON(path.join(chartDir, 'chart.json'), item);

    const master = await saveArtifact(session, `${CHART_API}/ChartMasterConfig/${uuid}`, chartDir, `${shortName}_master.json`, verbose, report);
    if (!master) return false;
    const versions = master?.ChartVersions || [];
    let complete = true;
    for (const entry of (onlyActiveVersions ? activeVersions(versions, 'ChartVersionConfigRec') : versions)) {
      const versionRecord = entry.ChartVersionConfigRec || entry;
      const versionUuid = versionRecord.ChartVersionConfigUuid;
      if (!versionUuid) continue;
      const versionName = safePathSegment(versionRecord.ChartVersionConfigInfo?.ShortName || versionUuid);
      const versionDir = path.join(chartDir, 'versions', versionName);
      ensureDir(versionDir);
      const version = await saveArtifact(session, `${CHART_API}/ChartVersionMasterConfig/${versionUuid}`, versionDir, `${versionName}.json`, verbose, report);
      if (version) complete = (await saveSeriesArtifacts(session, version, versionDir, verbose, report)) && complete;
      else complete = false;
    }
  return complete;
}

export async function getChartCommand(shortName, cmd) {
  const session = loadSession();
  const outputDir = cmd.output || './output/charts';
  setDir(outputDir);
  const chart = await findArtifactByShortName(session, `${CHART_API}/ChartConfigRec`, 'ChartConfigInfo.ShortName', shortName, chartSummary, cmd);
  const report = createArtifactFailureReport();
  await downloadChart(session, chart, outputDir, cmd.verbose, true, report);
  console.log(`✅ Saved chart ${shortName} to ${outputDir}`);
  report.print();
}
