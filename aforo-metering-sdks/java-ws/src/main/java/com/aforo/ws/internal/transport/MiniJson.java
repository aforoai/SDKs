package com.aforo.ws.internal.transport;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON reader for ingestor responses. The transport core has no
 * dependencies, so it cannot use Jackson; it only needs to read the small
 * {@code {success, data: {accepted, failed, errors[]}}} body.
 *
 * <p>Objects become {@link LinkedHashMap}, arrays {@link ArrayList}, numbers
 * {@link Double}, plus {@link String}, {@link Boolean} and {@code null}.</p>
 *
 * <p>This file is the transport core. Edit it in the {@code java} module only and
 * run {@code scripts/sync-transport.sh java}; the variants carry copies.</p>
 */
public final class MiniJson {

    private final String s;
    private int i;

    private MiniJson(String s) {
        this.s = s;
    }

    /** Parses one JSON value; throws {@link IllegalArgumentException} on malformed input. */
    public static Object parse(String text) {
        if (text == null) throw new IllegalArgumentException("null JSON text");
        MiniJson p = new MiniJson(text);
        p.ws();
        Object v = p.value(0);
        p.ws();
        if (p.i != p.s.length()) throw p.error("trailing characters");
        return v;
    }

    private Object value(int depth) {
        if (depth > 64) throw error("nesting too deep");
        if (i >= s.length()) throw error("unexpected end");
        char c = s.charAt(i);
        switch (c) {
            case '{': return object(depth);
            case '[': return array(depth);
            case '"': return string();
            case 't': literal("true"); return Boolean.TRUE;
            case 'f': literal("false"); return Boolean.FALSE;
            case 'n': literal("null"); return null;
            default:
                if (c == '-' || (c >= '0' && c <= '9')) return number();
                throw error("unexpected character");
        }
    }

    private Map<String, Object> object(int depth) {
        Map<String, Object> m = new LinkedHashMap<>();
        i++;
        ws();
        if (peek() == '}') { i++; return m; }
        while (true) {
            ws();
            if (peek() != '"') throw error("expected a key");
            String k = string();
            ws();
            expect(':');
            ws();
            m.put(k, value(depth + 1));
            ws();
            char c = next();
            if (c == '}') return m;
            if (c != ',') throw error("expected , or }");
        }
    }

    private List<Object> array(int depth) {
        List<Object> l = new ArrayList<>();
        i++;
        ws();
        if (peek() == ']') { i++; return l; }
        while (true) {
            ws();
            l.add(value(depth + 1));
            ws();
            char c = next();
            if (c == ']') return l;
            if (c != ',') throw error("expected , or ]");
        }
    }

    private String string() {
        expect('"');
        StringBuilder b = new StringBuilder();
        while (true) {
            char c = next();
            if (c == '"') return b.toString();
            if (c != '\\') { b.append(c); continue; }
            char e = next();
            switch (e) {
                case '"': b.append('"'); break;
                case '\\': b.append('\\'); break;
                case '/': b.append('/'); break;
                case 'b': b.append('\b'); break;
                case 'f': b.append('\f'); break;
                case 'n': b.append('\n'); break;
                case 'r': b.append('\r'); break;
                case 't': b.append('\t'); break;
                case 'u':
                    if (i + 4 > s.length()) throw error("bad unicode escape");
                    try {
                        b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                    } catch (NumberFormatException ex) {
                        throw error("bad unicode escape");
                    }
                    i += 4;
                    break;
                default: throw error("bad escape");
            }
        }
    }

    private Double number() {
        int start = i;
        if (peek() == '-') i++;
        while (i < s.length()) {
            char c = s.charAt(i);
            if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') i++;
            else break;
        }
        try {
            return Double.valueOf(s.substring(start, i));
        } catch (NumberFormatException e) {
            throw error("bad number");
        }
    }

    private void literal(String word) {
        if (!s.startsWith(word, i)) throw error("bad literal");
        i += word.length();
    }

    private void ws() {
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
            else break;
        }
    }

    private char peek() {
        if (i >= s.length()) throw error("unexpected end");
        return s.charAt(i);
    }

    private char next() {
        if (i >= s.length()) throw error("unexpected end");
        return s.charAt(i++);
    }

    private void expect(char c) {
        if (next() != c) throw error("expected '" + c + "'");
    }

    private IllegalArgumentException error(String what) {
        return new IllegalArgumentException("Malformed JSON at offset " + i + ": " + what);
    }
}
