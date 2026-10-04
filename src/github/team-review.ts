import type { BranchPolicy, GitHubPullRequest } from "./client.js";

function escapeRegex(character: string): string {
  return /[|\\{}()[\]^$+*?.]/.test(character) ? `\\${character}` : character;
}

function globRegex(pattern: string): RegExp {
  const rooted = pattern.startsWith("/");
  if (rooted) pattern = pattern.slice(1);
  if (pattern.endsWith("/")) pattern += "**";
  let source = rooted || pattern.includes("/") ? "^" : "(?:^|/)";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index] ?? "";
    const escaped = pattern[index + 1];
    if (character === "\\" && escaped !== undefined) {
      source += escapeRegex(escaped);
      index++;
    } else if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index++;
        if (pattern[index + 1] === "/") {
          source += "(?:.*/)?";
          index++;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) {
        source += "\\[";
      } else {
        let contents = pattern.slice(index + 1, close);
        if (contents.startsWith("!")) contents = `^${contents.slice(1)}`;
        source += `(?:(?!/)[${contents}])`;
        index = close;
      }
    } else {
      source += escapeRegex(character);
    }
  }
  return new RegExp(`${source}(?:/.*)?$`);
}

function patternListIncludesPath(patterns: readonly string[], path: string): boolean {
  let included = false;
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim();
    if (!pattern) continue;
    const excluded = pattern.startsWith("!");
    const glob = excluded ? pattern.slice(1) : pattern;
    if (glob && globRegex(glob).test(path)) included = !excluded;
  }
  return included;
}

export function requiredTeamReviewApplies(pullRequest: GitHubPullRequest, policy: BranchPolicy): boolean {
  if (!policy.known) return false;
  return policy.requiredTeamReviews.some((requirement) => {
    if (requirement.minimumApprovals <= 0) return false;
    if (requirement.filePatterns.length === 0 || pullRequest.changedFiles === undefined) return true;
    try {
      return pullRequest.changedFiles.some((path) => patternListIncludesPath(requirement.filePatterns, path));
    } catch {
      // Uninterpretable patterns remain subject to GitHub's authoritative gate.
      return true;
    }
  });
}

export function teamReviewGateSatisfied(pullRequest: GitHubPullRequest, policy: BranchPolicy): boolean {
  if (!requiredTeamReviewApplies(pullRequest, policy)) return true;
  return pullRequest.reviewDecision?.toUpperCase() === "APPROVED"
    && ["CLEAN", "UNSTABLE"].includes(pullRequest.mergeStateStatus?.toUpperCase() ?? "");
}
