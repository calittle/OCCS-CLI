import { loadSession } from './session.js';
import { paginate, get } from './api.js';
import { ensureDir, setDir, writeJSON, safePathSegment } from './utils.js';
import path from 'path';

export async function listCompaniesCommand(cmd) {
  console.log("(>'-')> Correlating companies...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/companies';
  setDir(outputDir);
  const companies = await paginate(
    session,
    '/api/Company/v1/CompanyRec',
    {
      depth: true,
      summary: true,
      totalResults: true,
      OrgCompanyRole: "Marketing",
      hierarchyInd: "%5B%22root%22%2C%22child%22%2C%22standalone%22%5D"
    },
    49,
    cmd.verbose
  );

  for (const co of companies) {
    const company = co.CompanyRec?.CompanyInfo?.OrgData?.OrgName.Items[0]?.ShortName;
    const uuid = co.CompanyRec?.CompanyUuid;
    const folder = path.join(outputDir, safePathSegment(company));
    ensureDir(folder);
    writeJSON(path.join(folder, `${uuid}.json`), co);
    
  }

  console.log(`✅ Saved ${companies.length} companies to ${outputDir}`);
}
