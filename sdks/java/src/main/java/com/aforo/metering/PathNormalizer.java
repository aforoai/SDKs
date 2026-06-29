package com.aforo.metering;

import java.util.regex.Pattern;

/**
 * Normalizes URL paths by replacing dynamic segments with :id placeholders.
 */
public final class PathNormalizer {

    private static final Pattern UUID_RE = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern NUMERIC_RE = Pattern.compile("^\\d+$");
    private static final Pattern MONGO_RE = Pattern.compile("^[0-9a-f]{24}$", Pattern.CASE_INSENSITIVE);
    private static final Pattern VERSION_RE = Pattern.compile("^v\\d+$", Pattern.CASE_INSENSITIVE);
    private static final Pattern MIXED_RE = Pattern.compile("^[a-zA-Z0-9_-]+$");

    private PathNormalizer() {}

    /**
     * Normalize a path, preferring the route template if provided.
     */
    public static String normalize(String actualPath, String routeTemplate) {
        if (routeTemplate != null && !routeTemplate.isBlank()) {
            return routeTemplate;
        }
        return normalize(actualPath);
    }

    /**
     * Normalize a path using heuristic segment replacement.
     */
    public static String normalize(String actualPath) {
        if (actualPath == null || actualPath.isEmpty()) return "/";

        String[] segments = actualPath.split("/", -1);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < segments.length; i++) {
            if (i > 0) sb.append('/');
            String seg = segments[i];
            if (seg.isEmpty()) continue;

            if (VERSION_RE.matcher(seg).matches()) {
                sb.append(seg);
            } else if (UUID_RE.matcher(seg).matches()
                    || NUMERIC_RE.matcher(seg).matches()
                    || MONGO_RE.matcher(seg).matches()) {
                sb.append(":id");
            } else if (seg.length() > 4 && seg.length() <= 12
                    && MIXED_RE.matcher(seg).matches()
                    && seg.chars().anyMatch(Character::isDigit)
                    && seg.chars().anyMatch(Character::isLetter)) {
                sb.append(":id");
            } else {
                sb.append(seg);
            }
        }

        String result = sb.toString();
        return result.isEmpty() ? "/" : result;
    }
}
