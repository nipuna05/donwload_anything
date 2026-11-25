// Publishes ./public to the gh-pages branch (served by GitHub Pages): npm run pages
import { execSync } from 'node:child_process';

const run = (cmd, ignore = false) => {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim(); }
  catch (e) { if (!ignore) throw e; }
};
if (run('git status --porcelain public')) { console.error('Commit your changes in public/ first.'); process.exit(1); }
run('git branch -D gh-pages', true);
const sha = run('git subtree split --prefix public -b gh-pages');
run('git push -f origin gh-pages');
run('git branch -D gh-pages', true);
console.log(`Published public/ (${sha.slice(0, 7)}). Live in a minute at the repo's GitHub Pages address.`);
