import { loadSession } from './session.js';
import { paginate } from './api.js';
import { ensureDir, setDir, writeJSON, safePathSegment, mapWithConcurrency } from './utils.js';
import path from 'path';
import { activeVersions, findArtifactByShortName } from './artifactLookup.js';
import { createArtifactFailureReport, getArtifact } from './artifactFailures.js';
import { resumeArtifact } from './exportResume.js';

function packageSummary(item) {
  const rec = item.CommunicationPackageConfigRec || {};
  return { shortName: rec.CommunicationPackageConfigInfo?.ShortName, uuid: rec.CommunicationPackageConfigUuid };
}

async function downloadPackage(session, pkg, outputDir, verbose, onlyActiveVersions = false, report) {
  const config = pkg.CommunicationPackageConfigRec;
  const info = config?.CommunicationPackageConfigInfo;
  const pkgUuid = config?.CommunicationPackageConfigUuid;
  if (!info?.ShortName || !pkgUuid) return false;

  const safeShortName = safePathSegment(info.ShortName);
  const folder = path.join(outputDir, safeShortName);
  ensureDir(folder);
  const master = await getArtifact(session, `/api/CommunicationPackage/v1/CommunicationPackageMasterConfig/${pkgUuid}`, { depth: true }, verbose, report);
  if (!master) return false;
  writeJSON(path.join(folder, `${safeShortName}_master.json`), master);

  const versions = master.CommunicationPackageMasterVersions || [];
  for (const v of (onlyActiveVersions ? activeVersions(versions, 'CommunicationPackageVersionConfigRec') : versions)) {
    const versionRec = v.CommunicationPackageVersionConfigRec;
    const versionInfo = versionRec?.CommunicationPackageVersionConfigInfo;
    const versionShortName = versionInfo?.ShortName || versionRec?.CommunicationPackageVersionConfigUuid;
    const pkgVersionUuid = versionRec?.CommunicationPackageVersionConfigUuid;
    if (!versionShortName || !pkgVersionUuid) continue;
    const safeVersionShortName = safePathSegment(versionShortName);
    const versionDir = path.join(folder, 'versions', safeVersionShortName);
    ensureDir(versionDir);
    writeJSON(path.join(versionDir, `${safeVersionShortName}.json`), versionRec);
    if (versionInfo?.DocumentJSONPathAssemblyTemplate?.Location) {
      const at = await getArtifact(session, `/api/CommunicationPackage/v1/CommunicationPackageVersionConfigRec/${pkgVersionUuid}/CommunicationPackageVersionConfigInfo/DocumentJSONPathAssemblyTemplate`, {}, verbose, report);
      if (at) writeJSON(path.join(versionDir, 'AssemblyTemplate.json'), at);
      else return false;
    }
  }
  return true;
}

export async function listPackagesCommand(cmd) {
  console.log("(>'-')> Pulling packages...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/packages';
  if (cmd.exportResume?.resumed) ensureDir(outputDir); else setDir(outputDir);

  const packages = await paginate(
    session,
    '/api/CommunicationPackage/v1/CommunicationPackageConfigRec',
    {
      depth: true,
      summary: true,
    },
    50,
    cmd.verbose
  );

  const report = createArtifactFailureReport();
  const results = await mapWithConcurrency(packages, cmd.concurrency ?? 4, async (pkg) => {
    const rec = pkg.CommunicationPackageConfigRec || {};
    const uuid = rec.CommunicationPackageConfigUuid;
    const shortName = rec.CommunicationPackageConfigInfo?.ShortName;
    if (!uuid || !shortName) return { ok: false };
    return resumeArtifact(cmd.exportResume, 'packages', uuid, pkg, path.join(outputDir, safePathSegment(shortName)), async () => {
      return downloadPackage(session, pkg, outputDir, cmd.verbose, false, report);
    });
  });

  console.log(`✅ Saved ${packages.length} packages to ${outputDir}`);
  report.print();
  return { ok: report.count === 0 && results.every((result) => result?.ok), skipped: results.filter((result) => result?.skipped).length };
}

export async function getPackageCommand(shortName, cmd) {
  const session = loadSession();
  const outputDir = cmd.output || './output/packages';
  setDir(outputDir);
  const pkg = await findArtifactByShortName(session, '/api/CommunicationPackage/v1/CommunicationPackageConfigRec', 'CommunicationPackageConfigInfo.ShortName', shortName, packageSummary, cmd);
  const report = createArtifactFailureReport();
  await downloadPackage(session, pkg, outputDir, cmd.verbose, true, report);
  console.log(`✅ Saved package ${shortName} to ${outputDir}`);
  report.print();
}
