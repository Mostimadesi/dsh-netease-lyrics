import fs from 'node:fs';
const p = new URL('../lib/client.js', import.meta.url);
let s = fs.readFileSync(p, 'utf8');
function replace(a,b) { if (!s.includes(a)) throw Error('Missing anchor: '+a); s=s.replace(a,b); }
replace('return h("div", { className: "dnl-host" },','return h("div", { className: "dnl-host", style: Object.fromEntries(COLOR_FIELDS.filter(([key]) => colors[key]).map(([key, , variable]) => [variable, colors[key]])) },');
replace('h("span", { className: "dnl-now-text" }, collapsedText),','h("span", { className: "dnl-now-text" }, collapsedText),\n\t\t\t\t\t\t\tcurrentLine && typeof currentLine.trans === "string" && currentLine.trans.trim()\n\t\t\t\t\t\t\t\t? h("span", { className: "dnl-now-trans" }, currentLine.trans) : null,');
replace('\t\t\t\t));\n\t\t\t} catch {','\t\t\t\t));\n\t\t\t\tctx.slots.inject("plugins.bundle.config", () => ctx.slots.register(\n\t\t\t\t\t{ name: "plugins.bundle.config", key: "dsh-netease-lyrics" }, ColorSettings));\n\t\t\t} catch {');
replace('.dnl-now{display:flex;align-items:baseline;gap:8px;min-height:22px}', '.dnl-now{display:flex;flex-direction:column;align-items:center;gap:1px;min-height:22px;min-width:0}');
replace('.dnl-now-text{color:var(--dsw-alias-label-primary);','.dnl-now-text{color:var(--dnl-original,var(--dsw-alias-label-primary));');
replace('.dnl-line-main{color:var(--dsw-alias-label-secondary);','.dnl-line-main{color:var(--dnl-original,var(--dsw-alias-label-secondary));');
replace('.dnl-line-trans{color:var(--dsw-alias-label-tertiary);','.dnl-line-trans{color:var(--dnl-translation,var(--dsw-alias-label-secondary));');
replace('.dnl-line-active .dnl-line-main{color:var(--dsw-alias-brand-primary);','.dnl-line-active .dnl-line-main{color:var(--dnl-active,var(--dnl-original,var(--dsw-alias-brand-primary)));');
replace('\t\t].join("");','\t\t\t".dnl-now-trans{color:var(--dnl-translation,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;max-width:48vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",\n\t\t\t".dnl-settings{color:var(--dsw-alias-label-primary);padding:12px 0}.dnl-settings p{color:var(--dsw-alias-label-secondary);font-size:12px}.dnl-color-row{display:flex;align-items:center;gap:12px;padding:10px 0;flex-wrap:wrap}.dnl-color-row input{width:40px;height:28px;cursor:pointer}.dnl-settings button{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 10px;cursor:pointer}.dnl-settings button:disabled{opacity:.5}",\n\t\t].join("");');
fs.writeFileSync(p,s);
const manifest = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(manifest,'utf8'));
pkg.dsh.client.inject.push('@deepseek-ai/dsh-client-ui-plugin-manager');
fs.writeFileSync(manifest,JSON.stringify(pkg,null,2)+'\n');
