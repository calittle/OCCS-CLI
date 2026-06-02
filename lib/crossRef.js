import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { writeCSV, getNameByUUID, safePathSegment } from './utils.js';
import { parseContentBlobs } from './blobUtils.js';

export async function crossrefCommand(cmd) {
  const baseDir = cmd.output || './output';
  const reportDir = path.join(baseDir, 'crossref');
  fs.mkdirSync(reportDir, { recursive: true });
  const verbose = cmd.verbose === true;

  /** @type {Array<[string, string, string, string, string, string, string]>} */
  const rows = [];

  const addRow = (rootDoc, sourceType, sourceId, relation, targetType, targetId, details = '') => {
    if (!sourceId || !targetId) return;
    rows.push([rootDoc, sourceType, sourceId, relation, targetType, targetId, details]);
  };

  const formatDetails = (details) => {
    const entries = Object.entries(details || {}).filter(([, value]) => {
      return value !== undefined && value !== null && value !== '';
    });

    if (entries.length === 0) return '';

    return entries
      .map(([key, value]) => {
        const safeValue = String(value).replace(/[;,]/g, '_');
        return `${key}=${safeValue}`;
      })
      .join('; ');
  };

  const getLayoutRelInfo = (layout) => {
    return (
      layout?.CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec
        ?.CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo
      || layout?.CommunicationLayoutConfigCommunicationLayoutConfigRelRec
        ?.CommunicationLayoutConfigCommunicationLayoutConfigRelInfo
      || {}
    );
  };

  const getStyleRelInfo = (styleRef) => {
    return (
      styleRef?.CommunicationDocumentVersionConfigCommunicationStyleConfigRelRec
        ?.CommunicationDocumentVersionConfigCommunicationStyleConfigRelInfo
      || styleRef?.CommunicationLayoutConfigCommunicationStyleConfigRelRec
        ?.CommunicationLayoutConfigCommunicationStyleConfigRelInfo
      || {}
    );
  };

  const getContentRelInfo = (contentRef) => {
    return (
      contentRef?.CommunicationDocumentVersionConfigCommunicationContentConfigRelRec
        ?.CommunicationDocumentVersionConfigCommunicationContentConfigRelInfo
      || contentRef?.CommunicationLayoutConfigCommunicationContentConfigRelRec
        ?.CommunicationLayoutConfigCommunicationContentConfigRelInfo
      || {}
    );
  };

  const getStyleName = (styleRef) => {
    return (
      styleRef?.ShortName
      || styleRef?.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo?.ShortName
      || 'unknown-style'
    );
  };

  function getFieldsUsedByContent(usageMap, contentId) {
    const result = [];

    for (const fieldId of Object.keys(usageMap)) {
        for (const usage of usageMap[fieldId]) {
        if (usage.contentId === contentId) {
            result.push({ fieldId, type: usage.type }); // type is 'data' or 'cond'
        }
        }
    }

    return result;
   }

  // ---- Load Fonts by FontFamily ----
  const fontMap = new Map();
  const fontsDir = path.join(baseDir, 'fonts');
  if (fs.existsSync(fontsDir)) {
    for (const folder of fs.readdirSync(fontsDir)) {
      const fontFile = path.join(fontsDir, folder, `${folder}.json`);
      if (!fs.existsSync(fontFile)) continue;
      const data = JSON.parse(fs.readFileSync(fontFile));
      const info = data.CommunicationFontConfigInfo || {};
      if (info.FontFamily) fontMap.set(info.FontFamily, info.ShortName || info.FontFamily);
    }
  }

  // ---- Parse Field Usage from Content Blobs ----
  const usageMap = parseContentBlobs(baseDir);
  // ---- Parse Document Versions  ----
  const docsDir = path.join(baseDir, 'documents');
  if (fs.existsSync(docsDir)) {
    for (const doc of fs.readdirSync(docsDir)) {
      const masterFile = path.join(docsDir, doc, `${doc}_master.json`);
      if (!fs.existsSync(masterFile)) continue;

      const masterData = JSON.parse(fs.readFileSync(masterFile));
      const docName = masterData.CommunicationDocumentConfigRec?.CommunicationDocumentConfigInfo?.ShortName || doc;

      const versionsDir = path.join(docsDir, doc, 'versions');
      if (!fs.existsSync(versionsDir)) continue;

      for (const versionFile of fs.readdirSync(versionsDir)) {
        if (!versionFile.endsWith('.json')) continue;
        const filePath = path.join(versionsDir, versionFile);
        const data = JSON.parse(fs.readFileSync(filePath));
        const docVersion = data.CommunicationDocumentVersionConfigRec?.CommunicationDocumentVersionConfigInfo?.ShortName || versionFile.replace('.json', '');
        
        // MASTER -> VERSION relationship (works)
        addRow(docName, 'Document', docName, 'has-version', 'DocumentVersion', docVersion);

        // DOCUMENT -> STYLES (works)
        const styles = data.CommunicationDocumentVersionStyles || [];
        for (const s of styles) {
          const info = s.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo;
          const relInfo = getStyleRelInfo(s);
          if (info) {
            addRow(
              docName,
              'DocumentVersion',
              docVersion,
              'uses',
              'Style',
              info.ShortName,
              formatDetails({
                styleRelIndex: relInfo.StyleRelIndex,
                styleClassName: relInfo.StyleClassName,
                depth: 0,
                parentType: 'DocumentVersion',
              })
            );
          }
        }

        const traverseLayout = (layout, parentLayoutId = null, depth = 0, pathParts = []) => {
          const info = layout.CommunicationLayoutConfigRec?.CommunicationLayoutConfigInfo || {};
          const layoutId = info.ShortName 
          || layout.CommunicationLayoutConfigRec?.CommunicationLayoutConfigUuid 
          || layout.ShortName
          || 'unknown-layout';
          const relInfo = getLayoutRelInfo(layout);
          const nextPathParts = [...pathParts, layoutId];
          const pathText = nextPathParts.join(' > ');

          //if (parentLayoutId) addRow(docName, 'Layout', parentLayoutId, 'uses', 'Layout', layoutId);
          addRow(
            docName,
            parentLayoutId ? 'Layout' : 'DocumentVersion',
            parentLayoutId || docVersion,
            'uses',
            'Layout',
            layoutId,
            formatDetails({
              depth,
              path: pathText,
              layoutRelIndex: relInfo.LayoutRelIndex,
              layoutAlwaysTriggerInd: relInfo.LayoutAlwaysTriggerInd,
              layoutPlacement: relInfo.LayoutPlacement,
              styleAreaName: relInfo.StyleAreaName,
            })
          );

          // load the layout JSON detail.
          const safeLayoutId = safePathSegment(layoutId);
          const layoutFile = path.join(baseDir, 'layouts', safeLayoutId, `${safeLayoutId}.json`);
          if (fs.existsSync(layoutFile)){
            const layoutData = JSON.parse(fs.readFileSync(layoutFile));
            
            // LAYOUT -> STYLES
            const layoutStyles = layout.CommunicationDocumentVersionLayoutStyles
              || layoutData.CommunicationLayoutStyles
              || [];
            for (const layoutStyle of layoutStyles) {                
                const layoutStyleInfo = getStyleRelInfo(layoutStyle);
                addRow(
                  docName,
                  'Layout',
                  layoutId,
                  'uses',
                  'Style',
                  getStyleName(layoutStyle),
                  formatDetails({
                    depth,
                    path: pathText,
                    styleRelIndex: layoutStyleInfo.StyleRelIndex,
                    styleClassName: layoutStyleInfo.StyleClassName,
                  })
                );
            }

            // LAYOUT -> CONTENTS
            const layoutContents = layout.CommunicationDocumentVersionLayoutContents
              || layoutData.CommunicationLayoutContents
              || [];
            for (const layoutContent of layoutContents) {   
                const contentName = layoutContent.ShortName || 'unknown-content';
                const layoutContentInfo = getContentRelInfo(layoutContent);
                addRow(
                  docName,
                  'Layout',
                  layoutId,
                  'uses',
                  'Content',
                  contentName,
                  formatDetails({
                    depth: depth + 1,
                    path: pathText,
                    contentRelIndex: layoutContentInfo.ContentRelIndex,
                    contentAlwaysTriggerInd: layoutContentInfo.ContentAlwaysTriggerInd,
                    styleAreaName: layoutContentInfo.StyleAreaName,
                  })
                );
           
                // CONTENT -> STYLES
                // read the master to obtain version numbers. Dump it all.
                const safeContentName = safePathSegment(contentName);
                const contentFile = path.join(baseDir, 'contents', safeContentName, `${safeContentName}_master.json`);
                if (fs.existsSync(contentFile)){                            
                    const contentData = JSON.parse(fs.readFileSync(contentFile));
                    const versions = contentData.CommunicationContentMasterVersions || [];
                    for (const version of versions){                        
                        const info = version.CommunicationContentVersionConfigRec?.CommunicationContentVersionConfigInfo;
                        const versionId = info.ShortName;
                        addRow(
                          docName,
                          'Content',
                          contentName,
                          'has-version',
                          'ContentVersion',
                          versionId,
                          formatDetails({
                            depth: depth + 1,
                            path: `${pathText} > ${contentName}`,
                            parentLayout: layoutId,
                          })
                        );
                        const items = info.CommunicationContentVersionConfigData?.Items || [];
                        for (const item of items) {
                            const classNames = item.StyleClassName || [];
                            for (const className of classNames) {
                                addRow(
                                  docName,
                                  'ContentVersion',
                                  versionId,
                                  'uses',
                                  'Style',
                                  className,
                                  formatDetails({
                                    depth: depth + 2,
                                    path: `${pathText} > ${contentName}`,
                                    content: contentName,
                                    contentVersion: versionId,
                                  })
                                );
                            }
                        }
                    }                                        
                }

                // CONTENT -> FIELDS
                const usages = getFieldsUsedByContent(usageMap, contentName);
                for (const { fieldId, type } of usages) {
                    const relation = type === 'data' ? 'uses' : 'conditional-on';
                    addRow(
                      docName,
                      'Content',
                      contentName,
                      relation,
                      'Field',
                      fieldId,
                      formatDetails({
                        usageType: type,
                        depth: depth + 1,
                        path: `${pathText} > ${contentName}`,
                      })
                    );
                }
            }
            
            // LAYOUT -> LAYOUT
            const layoutLayouts = layout.CommunicationDocumentVersionLayoutLayouts
              || layoutData.CommunicationLayoutLayouts
              || [];
            for (const layoutLayout of layoutLayouts) {                
                //addRow(docName, 'Layout', layoutId, 'uses', 'Layout', layoutLayouts.ShortName || 'unknown-layout');
                traverseLayout(layoutLayout, layoutId, depth + 1, nextPathParts);
            }
            
          }
        };

        const versionLayouts = data.CommunicationDocumentVersionLayouts || [];
        for (const layout of versionLayouts) {
          traverseLayout(layout);
        }
      }
    }
  }

  // ---- Styles → Fonts ----
  const stylesDir = path.join(baseDir, 'styles');
  if (fs.existsSync(stylesDir)) {
    for (const folder of fs.readdirSync(stylesDir)) {
      const file = path.join(stylesDir, folder, `${folder}.json`);
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file));
      const info = data.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo || {};
      const styleName = info.ShortName;
      const attrs = info.CommunicationStyleConfigStyleAttribute?.Items || [];
      for (const attr of attrs) {
        if (attr.StyleAttributeName === 'Font-family') {
          const font = fontMap.get(attr.StyleAttributeValue) || attr.StyleAttributeValue;
          addRow('', 'Style', styleName, 'uses', 'Font', font);
        }
      }
    }
  }

  // ---- Packages → Assembly Templates ----
  const packagesDir = path.join(baseDir, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const pkg of fs.readdirSync(packagesDir)) {
      const versionsDir = path.join(packagesDir, pkg, 'versions');
      if (!fs.existsSync(versionsDir)) continue;
      for (const v of fs.readdirSync(versionsDir)) {
        const atFile = path.join(versionsDir, v, 'AssemblyTemplate.json');
        if (!fs.existsSync(atFile)) continue;
        const data = JSON.parse(fs.readFileSync(atFile));
        const fields = data.Fields || [];
        const docs = data.Documents || [];
        for (const f of fields) addRow(pkg, 'Package', pkg, 'uses', 'Field', f.Name);
        for (const d of docs) addRow(pkg, 'Package', pkg, 'uses', 'Document', d["$$Id"]);
      }
    }
  }

  writeCSV(
    path.join(reportDir, 'crossref.csv'),
    ['RootDocument', 'SourceType', 'SourceId', 'Relation', 'TargetType', 'TargetId', 'Details'],
    rows
  );
  console.log(chalk.green(`✅ Wrote cross-reference report to ${reportDir}`));
}
