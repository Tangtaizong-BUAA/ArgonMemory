import assert from "node:assert/strict";
import {
  excerptAroundSearchQuery,
  rankSearchDocuments,
  tokenizeSearchQuery,
} from "../dist/search.js";

const question = [
  "On the Incidents list page, when I open the \"Filters\" dropdown,",
  "excluding \"Edit personal filters\" and \"-- None --\", which labels contain \"Incident\"?",
].join(" ");
const documents = [
  {
    item: "generic",
    key: "generic",
    title: "Generic ServiceNow page",
    text: `ServiceNow Incidents list ${"unrelated page ".repeat(400)} Filters menu`,
  },
  {
    item: "evidence",
    key: "evidence",
    title: "Expanded filter menu",
    text: [
      "ServiceNow Incidents list",
      "menuitem Filters expanded true",
      "menuitem Edit personal filters",
      "menuitem -- None --",
      "menuitem Active",
      "menuitem Incident Mobile",
      "menuitem Incident Portal",
      "menuitem My Open Incidents",
    ].join("\n"),
  },
];

const ranked = rankSearchDocuments(question, documents, 2);
assert.equal(ranked[0]?.item, "evidence", "quoted evidence phrases must outrank dispersed generic matches");
assert.match(ranked[0]?.excerpt ?? "", /Incident Mobile/);

const excerpt = excerptAroundSearchQuery(documents[1].text, question, 400);
assert.match(excerpt.text, /Incident Mobile/);
assert.match(excerpt.text, /My Open Incidents/);

const chineseTokens = tokenizeSearchQuery("长翼久安项目的产品矩阵是什么？");
assert.ok(chineseTokens.includes("长翼"), "Chinese queries must expose searchable bigrams");
assert.ok(chineseTokens.includes("产品"), "Chinese product terms must remain searchable");

console.log(JSON.stringify({
  status: "pass",
  top_document: ranked[0].key,
  top_score: ranked[0].score,
  chinese_tokens_checked: ["长翼", "产品"],
}));
