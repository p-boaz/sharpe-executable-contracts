// Contract keys (slugs of files under ../contracts/) → directory name under
// ../out/ that holds a committed, hand-crafted artifact bundle for that
// contract. Used to bypass LLM scenario generation in the web UI by copying
// the preloaded bundle into out/_web_runs/<key>/.
export const PRELOADED_FIXTURES: Record<string, string> = {
  "westex-visa-credit-card-agreement": "credit-card-agreement",
};
