/* Single place to point the site at the GitHub repository that publishes releases.
   The site worker (site/_worker.js) reads GITHUB_REPO from wrangler.jsonc instead,
   so keep both in step. */
window.ALCHEMIST_CONFIG = {
  repo: "jeelnadaa/alchemist",
};
