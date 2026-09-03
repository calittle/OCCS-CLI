import { loadSession } from './session.js';
import { paginate, get } from './api.js';
import { ensureDir, setDir, writeJSON, safePathSegment } from './utils.js';
import path from 'path';
import { activeVersions, findArtifactByShortName } from './artifactLookup.js';

function packageSummary(item) {
  const rec = item.CommunicationPackageConfigRec || {};
  return { shortName: rec.CommunicationPackageConfigInfo?.ShortName, uuid: rec.CommunicationPackageConfigUuid };
}

async function downloadPackage(session, pkg, outputDir, verbose, onlyActiveVersions = false) {
  const config = pkg.CommunicationPackageConfigRec;
  const info = config?.CommunicationPackageConfigInfo;
  const pkgUuid = config?.CommunicationPackageConfigUuid;
  if (!info?.ShortName || !pkgUuid) return false;

  const safeShortName = safePathSegment(info.ShortName);
  const folder = path.join(outputDir, safeShortName);
  ensureDir(folder);
  const master = await get(session, `/api/CommunicationPackage/v1/CommunicationPackageMasterConfig/${pkgUuid}`, { depth: true }, verbose);
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
      const at = await get(session, `/api/CommunicationPackage/v1/CommunicationPackageVersionConfigRec/${pkgVersionUuid}/CommunicationPackageVersionConfigInfo/DocumentJSONPathAssemblyTemplate`, {}, verbose);
      writeJSON(path.join(versionDir, 'AssemblyTemplate.json'), at);
    }
  }
  return true;
}

export async function listPackagesCommand(cmd) {
  console.log("(>'-')> Pulling packages...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/packages';
  setDir(outputDir);

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

  for (const pkg of packages) await downloadPackage(session, pkg, outputDir, cmd.verbose);

  console.log(`✅ Saved ${packages.length} packages to ${outputDir}`);
}

export async function getPackageCommand(shortName, cmd) {
  const session = loadSession();
  const outputDir = cmd.output || './output/packages';
  setDir(outputDir);
  const pkg = await findArtifactByShortName(session, '/api/CommunicationPackage/v1/CommunicationPackageConfigRec', 'CommunicationPackageConfigInfo.ShortName', shortName, packageSummary, cmd);
  await downloadPackage(session, pkg, outputDir, cmd.verbose, true);
  console.log(`✅ Saved package ${shortName} to ${outputDir}`);
}
