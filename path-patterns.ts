/**
 * Dependency-free path & glob primitives shared by the orchestrator.
 *
 * They live here so engines, verifiers, runners and tests agree on ONE answer.
 */

export const TEST_FILE_PATTERNS = [
	/(^|\/)tests?\//i,
	/(^|\/)__tests__\//i,
	/\.(test|spec)\.[a-z0-9]+$/i,
	/_test\.[a-z0-9]+$/i,
	/^test_[^/]+\.[a-z0-9]+$/i,
];

/**
 * NOTE: this strips a trailing `/`, so it is NOT interchangeable with the light
 * normalization inside `matchGlobPattern` (there a trailing `/` is a meaningful
 * directory-prefix pattern).
 */
export function normalizeRelPath(relPath: string): string {
	let out = relPath.replace(/\\/g, "/");
	while (out.startsWith("./")) out = out.slice(2);
	out = out.replace(/\/{2,}/g, "/");
	out = out.replace(/\/+$/, "");
	return out;
}

export function hasGlobWildcard(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?");
}

export function isTestFilePath(relPath: string): boolean {
	const normalized = relPath.replace(/\\/g, "/");
	return TEST_FILE_PATTERNS.some((re) => re.test(normalized));
}

export function matchGlobPattern(relPath: string, pattern: string): boolean {
	const cleanPath = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
	const cleanPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");

	if (cleanPath === cleanPattern) return true;
	if (cleanPattern.endsWith("/") && cleanPath.startsWith(cleanPattern)) return true;
	if (!cleanPattern.includes("*") && !cleanPattern.includes("?")) {
		if (cleanPath.startsWith(`${cleanPattern}/`)) return true;
		return cleanPath === cleanPattern;
	}

	let regexStr = "^";
	let i = 0;
	while (i < cleanPattern.length) {
		const c = cleanPattern[i];
		if (c === "*" && cleanPattern[i + 1] === "*") {
			if (cleanPattern[i + 2] === "/") {
				regexStr += "(?:.+/)?";
				i += 3;
				continue;
			}
			regexStr += ".*";
			i += 2;
			continue;
		}
		if (c === "*") {
			regexStr += "[^/]*";
			i++;
			continue;
		}
		if (c === "?") {
			regexStr += "[^/]";
			i++;
			continue;
		}
		if (".+^${}()|[]\\".includes(c)) {
			regexStr += `\\${c}`;
		} else {
			regexStr += c;
		}
		i++;
	}
	regexStr += "$";
	return new RegExp(regexStr).test(cleanPath);
}

export function matchesAnyPattern(relPath: string, patterns: string[]): boolean {
	return patterns.some((p) => matchGlobPattern(relPath, p));
}
