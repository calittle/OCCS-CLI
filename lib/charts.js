import path from 'path';
import { loadSession } from './session.js';
import { get, paginate } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment } from './utils.js';

const CHART_API = '/api/Chart/v1';

function nestedUuid(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

async function getArtifact(session, endpoint, verbose) {
  try {
    return await get(session, endpoint, { depth: true }, verbose, { throwOnError: true });
  } catch (error) {
    const status = error.response?.status || 'request';
    console.warn(`⚠ Skipped chart artifact (${status}): ${endpoint}`);
    return null;
  }
}

async function saveArtifact(session, endpoint, directory, fileName, verbose) {
  const artifact = await getArtifact(session, endpoint, verbose);
  if (artifact) writeJSON(path.join(directory, fileName), artifact);
  return artifact;
}

async function saveSeriesArtifacts(session, version, versionDir, verbose) {
  const plotSeries = version?.ChartVersionPlot?.ChartPlotSeries || [];
  const seriesDir = path.join(versionDir, 'series');

  for (const relation of plotSeries) {
    const uuid = nestedUuid(relation, ['ChartPlotConfigChartSeriesConfigRelRec', 'ChartPlotConfigChartSeriesConfigRelInfo', 'ChartSeriesConfigUuid']);
    if (!uuid) continue;

    ensureDir(seriesDir);
    const series = await saveArtifact(session, `${CHART_API}/ChartSeriesMasterConfig/${uuid}`, seriesDir, `${uuid}.json`, verbose);
    if (!series) continue;

    const categoryUuid = nestedUuid(series, ['ChartSeriesCategory', 'ChartSeriesConfigChartCategoryConfigRelRec', 'ChartSeriesConfigChartCategoryConfigRelInfo', 'ChartCategoryConfigUuid']);
    if (categoryUuid) {
      const categoryDir = path.join(versionDir, 'categories');
      ensureDir(categoryDir);
      const category = await saveArtifact(session, `${CHART_API}/ChartCategoryMasterConfig/${categoryUuid}`, categoryDir, `${categoryUuid}.json`, verbose);
      const categoryAxisUuid = nestedUuid(category, ['ChartCategoryAxis', 'ChartCategoryConfigChartCategoryAxisConfigRelRec', 'ChartCategoryConfigChartCategoryAxisConfigRelInfo', 'ChartCategoryAxisConfigUuid']);
      if (categoryAxisUuid) {
        const axisDir = path.join(versionDir, 'category-axes');
        ensureDir(axisDir);
        await saveArtifact(session, `${CHART_API}/ChartCategoryAxisMasterConfig/${categoryAxisUuid}`, axisDir, `${categoryAxisUuid}.json`, verbose);
      }
    }

    const seriesAxisUuid = nestedUuid(series, ['ChartSeriesAxis', 'ChartSeriesConfigChartSeriesAxisConfigRelRec', 'ChartSeriesConfigChartSeriesAxisConfigRelInfo', 'ChartSeriesAxisConfigUuid']);
    if (seriesAxisUuid) {
      const axisDir = path.join(versionDir, 'series-axes');
      ensureDir(axisDir);
      await saveArtifact(session, `${CHART_API}/ChartSeriesAxisMasterConfig/${seriesAxisUuid}`, axisDir, `${seriesAxisUuid}.json`, verbose);
    }

    const annotations = series.ChartSeriesAnnotations || [];
    for (const annotation of annotations) {
      const annotationUuid = nestedUuid(annotation, ['ChartSeriesConfigChartAnnotationConfigRelRec', 'ChartSeriesConfigChartAnnotationConfigRelInfo', 'ChartAnnotationConfigUuid']);
      if (!annotationUuid) continue;
      const annotationDir = path.join(versionDir, 'annotations');
      ensureDir(annotationDir);
      await saveArtifact(session, `${CHART_API}/ChartAnnotationMasterConfig/${annotationUuid}`, annotationDir, `${annotationUuid}.json`, verbose);
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

  for (const item of charts) {
    const record = item.ChartConfigRec || item;
    const info = record.ChartConfigInfo || {};
    const uuid = record.ChartConfigUuid;
    if (!uuid) continue;

    const shortName = safePathSegment(info.ShortName || uuid);
    const chartDir = path.join(outputDir, shortName);
    ensureDir(chartDir);
    writeJSON(path.join(chartDir, 'chart.json'), item);

    const master = await saveArtifact(session, `${CHART_API}/ChartMasterConfig/${uuid}`, chartDir, `${shortName}_master.json`, cmd.verbose);
    for (const entry of master?.ChartVersions || []) {
      const versionRecord = entry.ChartVersionConfigRec || entry;
      const versionUuid = versionRecord.ChartVersionConfigUuid;
      if (!versionUuid) continue;
      const versionName = safePathSegment(versionRecord.ChartVersionConfigInfo?.ShortName || versionUuid);
      const versionDir = path.join(chartDir, 'versions', versionName);
      ensureDir(versionDir);
      const version = await saveArtifact(session, `${CHART_API}/ChartVersionMasterConfig/${versionUuid}`, versionDir, `${versionName}.json`, cmd.verbose);
      if (version) await saveSeriesArtifacts(session, version, versionDir, cmd.verbose);
    }
  }

  console.log(`✅ Saved ${charts.length} charts to ${outputDir}`);
}
