import { loadSession } from './session.js';
import { paginate, get } from './api.js';
import { ensureDir, setDir, writeJSON, safePathSegment } from './utils.js';
import path from 'path';

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

  for (const pkg of packages) {
    const config = pkg.CommunicationPackageConfigRec;
    const info = config?.CommunicationPackageConfigInfo;
    const pkgUuid = config?.CommunicationPackageConfigUuid;

    if (!info?.ShortName || !pkgUuid) continue;

    const safeShortName = safePathSegment(info.ShortName);
    const folder = path.join(outputDir, safeShortName);
    ensureDir(folder);
    //writeJSON(path.join(folder, 'package.json'), pkg);

    // Get master config
    const master = await get(
      session,
      `/api/CommunicationPackage/v1/CommunicationPackageMasterConfig/${pkgUuid}`,
      { depth: true },
      cmd.verbose
    );

    writeJSON(path.join(folder, `${safeShortName}_master.json`), master);

    const versions = master.CommunicationPackageMasterVersions || [];

    for (const v of versions) {
      const versionRec = v.CommunicationPackageVersionConfigRec;
      const versionInfo = versionRec?.CommunicationPackageVersionConfigInfo;
      const versionShortName = versionInfo?.ShortName || versionRec?.CommunicationPackageVersionConfigUuid;
      const pkgVersionUuid = versionRec?.CommunicationPackageVersionConfigUuid;

      if (!versionShortName || !pkgVersionUuid) continue;

      const safeVersionShortName = safePathSegment(versionShortName);
      const versionDir = path.join(folder, 'versions', safeVersionShortName);
      ensureDir(versionDir);
      writeJSON(path.join(versionDir, `${safeVersionShortName}.json`), versionRec);

      const atPath = versionInfo?.DocumentJSONPathAssemblyTemplate?.Location;
      if (atPath) {
        const at = await get(
          session,
          `/api/CommunicationPackage/v1/CommunicationPackageVersionConfigRec/${pkgVersionUuid}/CommunicationPackageVersionConfigInfo/DocumentJSONPathAssemblyTemplate`,
          {},
          cmd.verbose
        );
        writeJSON(path.join(versionDir, 'AssemblyTemplate.json'), at);
      }
    }
  }

  console.log(`✅ Saved ${packages.length} packages to ${outputDir}`);
}
