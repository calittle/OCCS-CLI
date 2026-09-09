import path from 'path';
import { loadSession } from './session.js';
import { paginate } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment, mapWithConcurrency } from './utils.js';
import { activeVersions, findArtifactByShortName } from './artifactLookup.js';
import { createArtifactFailureReport, getArtifact } from './artifactFailures.js';

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

  for (const relation of plotSeries) {
    const uuid = nestedUuid(relation, ['ChartPlotConfigChartSeriesConfigRelRec', 'ChartPlotConfigChartSeriesConfigRelInfo', 'ChartSeriesConfigUuid']);
    if (!uuid) continue;

    ensureDir(seriesDir);
    const series = await saveArtifact(session, `${CHART_API}/ChartSeriesMasterConfig/${uuid}`, seriesDir, `${uuid}.json`, verbose, report);
    if (!series) continue;

    const categoryUuid = nestedUuid(series, ['ChartSeriesCategory', 'ChartSeriesConfigChartCategoryConfigRelRec', 'ChartSeriesConfigChartCategoryConfigRelInfo', 'ChartCategoryConfigUuid']);
    if (categoryUuid) {
      const categoryDir = path.join(versionDir, 'categories');
      ensureDir(categoryDir);
      const category = await saveArtifact(session, `${CHART_API}/ChartCategoryMasterConfig/${categoryUuid}`, categoryDir, `${categoryUuid}.json`, verbose, report);
      const categoryAxisUuid = nestedUuid(category, ['ChartCategoryAxis', 'ChartCategoryConfigChartCategoryAxisConfigRelRec', 'ChartCategoryConfigChartCategoryAxisConfigRelInfo', 'ChartCategoryAxisConfigUuid']);
      if (categoryAxisUuid) {
        const axisDir = path.join(versionDir, 'category-axes');
        ensureDir(axisDir);
        await saveArtifact(session, `${CHART_API}/ChartCategoryAxisMasterConfig/${categoryAxisUuid}`, axisDir, `${categoryAxisUuid}.json`, verbose, report);
      }
    }

    const seriesAxisUuid = nestedUuid(series, ['ChartSeriesAxis', 'ChartSeriesConfigChartSeriesAxisConfigRelRec', 'ChartSeriesConfigChartSeriesAxisConfigRelInfo', 'ChartSeriesAxisConfigUuid']);
    if (seriesAxisUuid) {
      const axisDir = path.join(versionDir, 'series-axes');
      ensureDir(axisDir);
      await saveArtifact(session, `${CHART_API}/ChartSeriesAxisMasterConfig/${seriesAxisUuid}`, axisDir, `${seriesAxisUuid}.json`, verbose, report);
    }

    const annotations = series.ChartSeriesAnnotations || [];
    for (const annotation of annotations) {
      const annotationUuid = nestedUuid(annotation, ['ChartSeriesConfigChartAnnotationConfigRelRec', 'ChartSeriesConfigChartAnnotationConfigRelInfo', 'ChartAnnotationConfigUuid']);
      if (!annotationUuid) continue;
      const annotationDir = path.join(versionDir, 'annotations');
      ensureDir(annotationDir);
      await saveArtifact(session, `${CHART_API}/ChartAnnotationMasterConfig/${annotationUuid}`, annotationDir, `${annotationUuid}.json`, verbose, report);
    }
  }
}

export async function listChartsCommand(cmd) {
  console.log("(>'-')> Charting chartifacts...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/charts';
  setDir(outputDir);

  const charts = await paginate(
    session,
    `${CHART_API}/ChartConfigRec`,
    { depth: true, summary: true, totalResults: true },
    49,
    cmd.verbose
  );

  const report = createArtifactFailureReport();
  await mapWithConcurrency(charts, cmd.concurrency ?? 4, (item) => downloadChart(session, item, outputDir, cmd.verbose, false, report));

  console.log(`✅ Saved ${charts.length} charts to ${outputDir}`);
  report.print();
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
    const versions = master?.ChartVersions || [];
    for (const entry of (onlyActiveVersions ? activeVersions(versions, 'ChartVersionConfigRec') : versions)) {
      const versionRecord = entry.ChartVersionConfigRec || entry;
      const versionUuid = versionRecord.ChartVersionConfigUuid;
      if (!versionUuid) continue;
      const versionName = safePathSegment(versionRecord.ChartVersionConfigInfo?.ShortName || versionUuid);
      const versionDir = path.join(chartDir, 'versions', versionName);
      ensureDir(versionDir);
      const version = await saveArtifact(session, `${CHART_API}/ChartVersionMasterConfig/${versionUuid}`, versionDir, `${versionName}.json`, verbose, report);
      if (version) await saveSeriesArtifacts(session, version, versionDir, verbose, report);
    }
  return true;
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
