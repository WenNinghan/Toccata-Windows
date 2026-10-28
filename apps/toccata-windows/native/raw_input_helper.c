#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* Windows Raw Input helper. It is started and supervised by the desktop app.
   This process never suppresses input and does not write events to disk. */
#define MAX_DOWN 512
#define MAX_PACKET 65536
#define MAX_WIDE_PATH 32768
/* Four UTF-8 bytes per UTF-16 code unit is a conservative upper bound. */
#define MAX_UTF8_PATH (MAX_WIDE_PATH * 4)

typedef struct {
    uintptr_t device;
    USHORT scan, ext, fallback_vkey;
    ULONGLONG started;
    int used;
} KeyDown;
typedef struct { KeyDown items[MAX_DOWN]; } Tracker;
typedef enum { DOWN, REPEAT, UP, ORPHAN, FULL } ResultKind;
typedef struct { ResultKind kind; ULONGLONG hold_ms; } Result;

/* Encode one UTF-8 byte for JSON; non-ASCII UTF-8 bytes pass through unchanged. */
static size_t json_escape_byte(unsigned char value, char out[7]) {
    if (value == '"' || value == '\\') { out[0] = '\\'; out[1] = (char)value; return 2; }
    if (value < 0x20) { snprintf(out, 7, "\\u%04x", (unsigned)value); return 6; }
    out[0] = (char)value; return 1;
}
static int wide_to_utf8(const wchar_t *source, char *output, int capacity) {
    return WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, source, -1,
                               output, capacity, NULL, NULL) > 0;
}

/* A zero scan code is not a physical identity. Keep its VK separately so
   unrelated devices/keys do not collapse onto the same down slot. */
static Result transition(Tracker *t, uintptr_t dev, USHORT scan, USHORT ext,
                         USHORT vkey, int down, ULONGLONG now) {
    int found = -1, available = -1;
    USHORT fallback = scan == 0 ? vkey : 0;
    for (int i = 0; i < MAX_DOWN; i++) {
        KeyDown *s = &t->items[i];
        if (!s->used) { if (available < 0) available = i; }
        else if (s->device == dev && s->scan == scan && s->ext == ext &&
                 s->fallback_vkey == fallback) { found = i; break; }
    }
    Result result = { ORPHAN, 0 };
    if (down) {
        if (found >= 0) result.kind = REPEAT;
        else if (available < 0) result.kind = FULL;
        else {
            t->items[available] = (KeyDown){dev, scan, ext, fallback, now, 1};
            result.kind = DOWN;
        }
    } else if (found >= 0) {
        KeyDown *s = &t->items[found];
        result.kind = UP;
        result.hold_ms = now >= s->started ? now - s->started : 0;
        memset(s, 0, sizeof(*s));
    }
    return result;
}

static void forget_device(Tracker *t, uintptr_t dev) {
    for (int i = 0; i < MAX_DOWN; i++)
        if (t->items[i].used && t->items[i].device == dev)
            memset(&t->items[i], 0, sizeof(t->items[i]));
}
static int self_test(void) {
    Tracker t = {0}; Result r;
    r = transition(&t, 1, 30, 0, 65, 1, 100); if (r.kind != DOWN) return 1;
    r = transition(&t, 1, 30, 0, 65, 1, 400); if (r.kind != REPEAT) return 2;
    r = transition(&t, 1, 30, 0, 65, 0, 3100); if (r.kind != UP || r.hold_ms != 3000) return 3;
    r = transition(&t, 1, 30, 0, 65, 0, 3200); if (r.kind != ORPHAN) return 4;
    transition(&t, 1, 29, 0, 17, 1, 4000);
    transition(&t, 1, 30, 0, 65, 1, 4010);
    r = transition(&t, 1, 30, 0, 65, 0, 4100); if (r.kind != UP || r.hold_ms != 90) return 5;
    r = transition(&t, 1, 29, 0, 17, 0, 4200); if (r.kind != UP || r.hold_ms != 200) return 6;
    transition(&t, 1, 30, 0, 65, 1, 5000); transition(&t, 2, 30, 0, 65, 1, 5010);
    r = transition(&t, 2, 30, 0, 65, 0, 5100); if (r.kind != UP || r.hold_ms != 90) return 7;
    forget_device(&t, 1);
    r = transition(&t, 1, 30, 0, 65, 0, 5200); if (r.kind != ORPHAN) return 8;
    transition(&t, 1, 29, 0, 17, 1, 6000); transition(&t, 1, 29, RI_KEY_E0, 17, 1, 6010);
    r = transition(&t, 1, 29, RI_KEY_E0, 17, 0, 6100); if (r.kind != UP || r.hold_ms != 90) return 9;
    transition(&t, 3, 0, 0, 65, 1, 7000); transition(&t, 3, 0, 0, 66, 1, 7050);
    r = transition(&t, 3, 0, 0, 66, 0, 7100); if (r.kind != UP || r.hold_ms != 50) return 10;
    char escaped[7]; size_t n;
    n = json_escape_byte('\\', escaped); if (n != 2 || memcmp(escaped,"\\\\",2)) return 11;
    n = json_escape_byte('"', escaped); if (n != 2 || memcmp(escaped,"\\\"",2)) return 12;
    n = json_escape_byte('\n', escaped); if (n != 6 || memcmp(escaped,"\\u000a",6)) return 13;
    n = json_escape_byte(0xe4, escaped); if (n != 1 || (unsigned char)escaped[0] != 0xe4) return 14;
    const wchar_t unicode[] = { L'C', L':', L'\\', 0x4e2d, 0x6587, L'\\', L'a', L'.', L'e', L'x', L'e', 0 };
    char utf8[32];
    if (!wide_to_utf8(unicode, utf8, (int)sizeof(utf8)) ||
        strcmp(utf8, "C:\\" "\xe4\xb8\xad\xe6\x96\x87" "\\a.exe")) return 15;
    char too_small[4]; if (wide_to_utf8(unicode, too_small, (int)sizeof(too_small))) return 16;
    wchar_t long_path[MAX_WIDE_PATH]; char long_utf8[MAX_UTF8_PATH];
    for (int i = 0; i < MAX_WIDE_PATH - 1; i++) long_path[i] = L'a';
    long_path[MAX_WIDE_PATH - 1] = 0;
    if (!wide_to_utf8(long_path, long_utf8, (int)sizeof(long_utf8)) || strlen(long_utf8) != MAX_WIDE_PATH - 1) return 17;
    const wchar_t surrogate[] = { 0xd83d, 0xde80, 0 };
    if (!wide_to_utf8(surrogate, utf8, (int)sizeof(utf8)) ||
        strcmp(utf8, "\xf0\x9f\x9a\x80")) return 18;
    const wchar_t invalid_surrogate[] = { 0xd83d, 0 };
    if (wide_to_utf8(invalid_surrogate, utf8, (int)sizeof(utf8))) return 19;
    puts("PASS: repeat, hold, chord, device, removal, extended and zero-scan handling");
    return 0;
}

static Tracker tracker;
static unsigned long long event_id = 0;

static long long unix_ms(void) {
    FILETIME ft; ULARGE_INTEGER n;
    GetSystemTimeAsFileTime(&ft);
    n.LowPart = ft.dwLowDateTime; n.HighPart = ft.dwHighDateTime;
    return (long long)(n.QuadPart / 10000ULL) - 11644473600000LL;
}
static void json_string(const char *s) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        char encoded[7]; size_t length = json_escape_byte(*p, encoded);
        (void)fwrite(encoded, 1, length, stdout);
    }
    putchar('"');
}
static void foreground_app(char *out, int out_size, int *has_app,
                           char *exe_path, int exe_path_size, int *has_path) {
    *has_app = 0; *has_path = 0;
    DWORD pid = 0; HWND foreground = GetForegroundWindow();
    if (!foreground) return;
    GetWindowThreadProcessId(foreground, &pid);
    if (!pid) return;
    HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!proc) return;
    wchar_t path[MAX_WIDE_PATH]; DWORD len = (DWORD)(sizeof(path)/sizeof(path[0]));
    BOOL ok = QueryFullProcessImageNameW(proc, 0, path, &len);
    CloseHandle(proc);
    if (!ok || !len || len >= MAX_WIDE_PATH) return;
    path[len] = L'\0';
    const wchar_t *name = wcsrchr(path, L'\\');
    name = name ? name + 1 : path;
    *has_app = wide_to_utf8(name, out, out_size);
    *has_path = wide_to_utf8(path, exe_path, exe_path_size);
}
static void emit_key(const RAWINPUT *input, Result result, long long ts) {
    const RAWKEYBOARD *k = &input->data.keyboard;
    char app[1024], exe_path[MAX_UTF8_PATH]; int has_app, has_path;
    foreground_app(app, (int)sizeof(app), &has_app, exe_path, (int)sizeof(exe_path), &has_path);
    const char *kind = result.kind == DOWN ? "down" : "up";
    unsigned ext = k->Flags & (RI_KEY_E0 | RI_KEY_E1);
    printf("{\"type\":\"key\",\"event_id\":%llu,\"scan\":%u,\"ext\":%u,\"vkey\":%u,\"device\":\"%llx\",\"kind\":\"%s\",\"ts_ms\":%lld,\"hold_ms\":",
           ++event_id, (unsigned)k->MakeCode, ext, (unsigned)k->VKey,
           (unsigned long long)(uintptr_t)input->header.hDevice, kind, ts);
    if (result.kind == UP) printf("%llu", (unsigned long long)result.hold_ms); else fputs("null", stdout);
    fputs(",\"app\":", stdout);
    if (has_app) json_string(app); else fputs("null", stdout);
    fputs(",\"exe_path\":", stdout);
    if (has_path) json_string(exe_path); else fputs("null", stdout);
    fputs("}\n", stdout); fflush(stdout);
}
static void emit_reset(const char *reason, uintptr_t dev, int all) {
    fputs("{\"type\":\"reset\",\"reason\":", stdout); json_string(reason);
    if (all) fputs(",\"device\":null}\n", stdout);
    else printf(",\"device\":\"%llx\"}\n", (unsigned long long)dev);
    fflush(stdout);
}
static void handle_input(LPARAM param) {
    UINT size = 0;
    if (GetRawInputData((HRAWINPUT)param, RID_INPUT, NULL, &size, sizeof(RAWINPUTHEADER)) != 0 ||
        size < sizeof(RAWINPUTHEADER) || size > MAX_PACKET) return;
    unsigned char *bytes = (unsigned char *)malloc(size);
    if (!bytes) return;
    UINT got = GetRawInputData((HRAWINPUT)param, RID_INPUT, bytes, &size, sizeof(RAWINPUTHEADER));
    if (got != (UINT)-1 && got >= sizeof(RAWINPUTHEADER) + sizeof(RAWKEYBOARD)) {
        RAWINPUT *input = (RAWINPUT *)bytes;
        if (input->header.dwType == RIM_TYPEKEYBOARD) {
            RAWKEYBOARD *k = &input->data.keyboard;
            if (k->VKey != 255) {
                int down = !(k->Flags & RI_KEY_BREAK);
                USHORT ext = k->Flags & (RI_KEY_E0 | RI_KEY_E1);
                Result r = transition(&tracker, (uintptr_t)input->header.hDevice, k->MakeCode,
                                      ext, k->VKey, down, GetTickCount64());
                if (r.kind == DOWN || r.kind == UP || r.kind == ORPHAN) emit_key(input, r, unix_ms());
                else if (r.kind == FULL) {
                    fputs("{\"type\":\"warning\",\"reason\":\"held_key_capacity\"}\n", stdout); fflush(stdout);
                }
            }
        }
    }
    free(bytes);
}
static LRESULT CALLBACK window_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_INPUT: handle_input(lp); return DefWindowProcW(hwnd, msg, wp, lp);
    case WM_INPUT_DEVICE_CHANGE:
        if (wp == GIDC_REMOVAL) {
            forget_device(&tracker, (uintptr_t)lp);
            emit_reset("device_removed", (uintptr_t)lp, 0);
        }
        return 0;
    case WM_POWERBROADCAST:
        if (wp == PBT_APMSUSPEND) { memset(&tracker, 0, sizeof(tracker)); emit_reset("suspend", 0, 1); }
        return TRUE;
    case WM_CLOSE: DestroyWindow(hwnd); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}
static DWORD WINAPI read_commands(LPVOID data) {
    HWND hwnd = (HWND)data; char line[256];
    while (fgets(line, sizeof(line), stdin)) {
        if (strncmp(line, "quit", 4) == 0 || strstr(line, "\"quit\"") != NULL) break;
    }
    PostMessageW(hwnd, WM_CLOSE, 0, 0); return 0;
}
int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return self_test();
    if (argc != 1) {
        fprintf(stderr, "Usage: raw_input_helper.exe [--self-test]\n");
        return 64;
    }
    HINSTANCE instance = GetModuleHandleW(NULL);
    WNDCLASSW wc = {0}; wc.lpfnWndProc = window_proc; wc.hInstance = instance; wc.lpszClassName = L"ToccataWindowsRawInputHelper";
    if (!RegisterClassW(&wc)) { fprintf(stderr, "RegisterClass failed: %lu\n", GetLastError()); return 1; }
    /* A hidden top-level window receives both background Raw Input and suspend broadcasts. */
    HWND hwnd = CreateWindowW(wc.lpszClassName, L"Toccata input helper", WS_OVERLAPPED,
                               0, 0, 0, 0, NULL, NULL, instance, NULL);
    if (!hwnd) { fprintf(stderr, "CreateWindow failed: %lu\n", GetLastError()); return 2; }
    RAWINPUTDEVICE rid = {1, 6, RIDEV_INPUTSINK | RIDEV_DEVNOTIFY, hwnd};
    if (!RegisterRawInputDevices(&rid, 1, sizeof(rid))) {
        fprintf(stderr, "RegisterRawInputDevices failed: %lu\n", GetLastError()); DestroyWindow(hwnd); return 3;
    }
    HANDLE reader = CreateThread(NULL, 0, read_commands, hwnd, 0, NULL);
    if (!reader) { fprintf(stderr, "CreateThread failed: %lu\n", GetLastError()); DestroyWindow(hwnd); return 4; }
    CloseHandle(reader);
    fputs("{\"type\":\"ready\",\"protocol\":1}\n", stdout); fflush(stdout);
    MSG msg; int got;
    while ((got = GetMessageW(&msg, NULL, 0, 0)) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
    return got < 0 ? 5 : 0;
}
