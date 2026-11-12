/* Single place to point the site at the GitHub repository that publishes releases.
   The Cloudflare Pages Function reads the GITHUB_REPO environment variable instead,
   so set both when the repository is created. */
window.ALCHEMIST_CONFIG = {
  repo: "jeelnadaa/alchemist",
};
