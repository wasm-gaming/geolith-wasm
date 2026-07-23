/*
 * geo_shim.c — WebAssembly bridge for the Geolith Neo Geo emulator core.
 *
 * Replaces the Jolly Good API frontend (jg.c) with a flat C ABI the JS SDK
 * drives directly: one geowasm_exec() per frame, a static XRGB framebuffer
 * converted to RGBA for canvas upload, a per-frame int16 audio buffer, and
 * bitmask-based input state polled by the core's input callbacks.
 *
 * Everything here mirrors the wiring in upstream jg.c (input bit semantics,
 * init ordering, mixer setup, special controllers, CD flow) minus SDL/JG
 * dependencies.
 */

#include <dirent.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>

#include <emscripten.h>
#include <miniz.h>

#include "geo.h"
#include "geo_cd.h"
#include "geo_disc.h"
#include "geo_lspc.h"
#include "geo_m68k.h"
#include "geo_mixer.h"
#include "geo_neo.h"

#define KEEPALIVE EMSCRIPTEN_KEEPALIVE

/* ------------------------------------------------------------------ video */

/* XRGB8888 buffer the LSPC renders into: pitch LSPC_WIDTH, LSPC_SCANLINES
   lines maximum (matches upstream vidinfo wmax/hmax). */
static uint32_t vbuf[LSPC_WIDTH * LSPC_SCANLINES];

/* RGBA output for the visible crop, packed w*h, ready for ImageData. */
static uint32_t rgbabuf[LSPC_WIDTH * LSPC_SCANLINES];

/* ------------------------------------------------------------------ audio */

/* Per-frame interleaved stereo int16 output from the mixer. At 96kHz the
   mixer emits ~3246 int16 values per frame; leave generous headroom. */
static int16_t abuf[16384];

/* Number of int16 values the mixer produced during the last geo_exec(). */
static size_t audio_samps = 0;

static void shim_mixer_cb(size_t samps) {
    audio_samps = samps;
}

/* ------------------------------------------------------------------ input */

/* Input device modes, mirroring jg.c's "input" setting. */
#define INPUT_MODE_AUTO     0
#define INPUT_MODE_JS       1
#define INPUT_MODE_MAHJONG  2
#define INPUT_MODE_4P       3

/* Active-high button masks set from JS. Meaning depends on the active device:
   Joystick (per player):
     bit 0..3 = up/down/left/right, bit 4..7 = A/B/C/D,
     bit 8 = start, bit 9 = select.
   Mahjong (player 1): bit 0..20 = A..N, Pon, Chi, Kan, Reach, Ron,
     Select, Start (jg_neogeo defs order).
   V-Liner (player 1): bit 0..10 = Up, Down, Left, Right, Big, Small, D-Up,
     Start, Operator, ClearCredit, HopperOut.
   Irritating Maze (player 1): bit 0..3 = LeftA/LeftB/RightA/RightB,
     bit 4 = Start. Trackball via geowasm_input_axis(). */
static uint32_t input_btn[4] = { 0, 0, 0, 0 };

/* Active-high system mask: bit 0 coin1, 1 coin2, 2 service, 3 test. */
static uint32_t input_sys = 0;

/* Relative trackball deltas for the current frame (Irritating Maze). */
static int32_t axis_x = 0;
static int32_t axis_y = 0;
static int32_t trackball_x = 0;
static int32_t trackball_y = 0;

/* Memory card emulation flags (mirrors jg.c settings defaults). */
static uint32_t memcard_inserted = 1;
static uint32_t memcard_wp = 0;

/* DIP switch state (freeplay bit 0x40, setting mode bit 0x01). */
static uint32_t dip_freeplay = 0;
static uint32_t dip_settingmode = 0;

/* Hardwired DIP bits selected by the input mode (mahjong 0x04, 4P 0x02). */
static unsigned dipswitches = 0;

/* Coin slot 3/4 bits for REG_STATUS_A (set high on MVS, see jg.c). */
static unsigned coins34 = 0x00;

/* Setup parameters remembered for input-mode wiring after ROM load. */
static int cfg_system = SYSTEM_MVS;
static int cfg_region = REGION_US;
static int cfg_unihw = SYSTEM_MVS;
static int cfg_input_mode = INPUT_MODE_AUTO;

/* Controller port poll: active-low hardware bits from active-high JS mask. */
static unsigned shim_poll_js(unsigned port) {
    unsigned b = 0xff;
    uint32_t m = input_btn[port & 3];

    if (m & 0x01) b &= ~(1 << 0); /* Up */
    if (m & 0x02) b &= ~(1 << 1); /* Down */
    if (m & 0x04) b &= ~(1 << 2); /* Left */
    if (m & 0x08) b &= ~(1 << 3); /* Right */
    if (m & 0x10) b &= ~(1 << 4); /* A */
    if (m & 0x20) b &= ~(1 << 5); /* B */
    if (m & 0x40) b &= ~(1 << 6); /* C */
    if (m & 0x80) b &= ~(1 << 7); /* D */

    return b;
}

/* Neo Geo Joystick via NEO-FTC1B 4-player extension (2 players per cabinet).
   The port argument is the cabinet; output pin 1 selects which player's
   controls are read, pin 3 injects A/B presses (see upstream jg.c). */
static unsigned shim_poll_js_ftc1b(unsigned port) {
    unsigned b = 0xff;

    uint8_t output = geo_m68k_reg_poutput();
    port = (port << 1) + (output & 0x01);

    if (output & 0x04)
        b &= ~(1 << (4 | (output & 0x01)));

    uint32_t m = input_btn[port & 3];
    if (m & 0x01) b &= ~(1 << 0);
    if (m & 0x02) b &= ~(1 << 1);
    if (m & 0x04) b &= ~(1 << 2);
    if (m & 0x08) b &= ~(1 << 3);
    if (m & 0x10) b &= ~(1 << 4);
    if (m & 0x20) b &= ~(1 << 5);
    if (m & 0x40) b &= ~(1 << 6);
    if (m & 0x80) b &= ~(1 << 7);

    return b;
}

/* Neo Geo Mahjong Controller: three banks selected via output pins. */
static unsigned shim_poll_mahjong(unsigned port) {
    unsigned b = 0xff;

    if (port)
        return b;

    uint8_t output = geo_m68k_reg_poutput();
    uint32_t m = input_btn[0];

    if (output & 0x01) {
        for (unsigned i = 0; i < 7; ++i) {
            if (m & (1u << i)) b &= ~(1 << i);
        }
    }
    if (output & 0x02) {
        for (unsigned i = 0; i < 7; ++i) {
            if (m & (1u << (i + 7))) b &= ~(1 << i);
        }
    }
    if (output & 0x04) {
        for (unsigned i = 0; i < 5; ++i) {
            if (m & (1u << (i + 14))) b &= ~(1 << i);
        }
    }

    return b;
}

/* V-Liner play buttons: bits 0..7 map directly. */
static unsigned shim_poll_vliner(unsigned port) {
    unsigned b = 0xff;
    uint32_t m = input_btn[port & 3];
    for (unsigned i = 0; i < 8; ++i) {
        if (m & (1u << i)) b &= ~(1 << i);
    }
    return b;
}

/* The Irritating Maze: trackball counters on port 0, buttons on port 1. */
static unsigned shim_poll_irrmaze(unsigned port) {
    unsigned b = 0xff;

    if (port == 0) {
        uint8_t output = geo_m68k_reg_poutput();
        if (output & 0x01) {
            trackball_y -= axis_y;
            b = (uint8_t)(trackball_y / 8192);
        }
        else {
            trackball_x -= axis_x;
            b = (uint8_t)(trackball_x / 8192);
        }
    }
    else {
        uint32_t m = input_btn[0];
        if (m & 0x01) b &= ~0x10; /* Left A */
        if (m & 0x02) b &= ~0x20; /* Left B */
        if (m & 0x04) b &= ~0x40; /* Right A */
        if (m & 0x08) b &= ~0x80; /* Right B */
    }

    return b;
}

static unsigned shim_poll_none(unsigned port) {
    (void)port;
    return 0xff;
}

/* REG_STATUS_A: coin slots and service button (active low). */
static unsigned shim_poll_stat_a(void) {
    unsigned c = 0x07;

    if (input_sys & 0x01) c &= 0x06; /* Coin 1 */
    if (input_sys & 0x02) c &= 0x05; /* Coin 2 */
    if (input_sys & 0x04) c &= 0x03; /* Service */

    c |= coins34;

    return c;
}

static unsigned shim_poll_stat_a_vliner(void) {
    return 0x07;
}

static unsigned memcard_stat_bits(void) {
    unsigned s = 0;
    if (memcard_inserted) {
        if (memcard_wp) s |= 0x40;
    }
    else {
        s |= 0x30;
    }
    return s;
}

/* REG_STATUS_B: P1/P2 Start+Select, memory card status. */
static unsigned shim_poll_stat_b(void) {
    unsigned s = 0x0f | memcard_stat_bits();

    if (input_btn[0] & 0x200) s &= 0x0d; /* P1 Select */
    if (input_btn[0] & 0x100) s &= 0x0e; /* P1 Start */
    if (input_btn[1] & 0x200) s &= 0x07; /* P2 Select */
    if (input_btn[1] & 0x100) s &= 0x0b; /* P2 Start */

    return s;
}

/* Start bits for the 4-player extension board (players muxed per cabinet). */
static unsigned shim_poll_stat_b_ftc1b(void) {
    unsigned s = 0x0f | memcard_stat_bits();

    if (geo_m68k_reg_poutput() & 0x01) { /* Players 2/4 */
        if (input_btn[1] & 0x100) s &= 0x0e;
        if (input_btn[3] & 0x100) s &= 0x0b;
    }
    else { /* Players 1/3 */
        if (input_btn[0] & 0x100) s &= 0x0e;
        if (input_btn[2] & 0x100) s &= 0x0b;
    }
    return s;
}

static unsigned shim_poll_stat_b_mahjong(void) {
    unsigned s = 0x0f | memcard_stat_bits();

    if (cfg_system == SYSTEM_AES) {
        if (geo_m68k_reg_poutput() & 0x04)
            s &= 0x0d;
    }

    if (input_btn[0] & (1u << 19)) s &= 0x0d; /* Select */
    if (input_btn[0] & (1u << 20)) s &= 0x0e; /* Start */

    return s;
}

static unsigned shim_poll_stat_b_vliner(void) {
    return 0x0f | memcard_stat_bits();
}

static unsigned shim_poll_stat_b_irrmaze(void) {
    unsigned s = 0x0f | memcard_stat_bits();

    if (input_btn[0] & 0x10) s &= ~0x01; /* Start */
    return s;
}

/* Test button, slot type. */
static unsigned shim_poll_systype(void) {
    unsigned t = 0xc0;
    if (input_sys & 0x08) /* Test */
        t &= 0x40;
    return t;
}

/* MVS DIP switches (active low). */
static unsigned shim_poll_dipsw(void) {
    unsigned d = 0xff;

    if (dip_freeplay)
        d &= ~0x40;
    if (dip_settingmode)
        d &= ~0x01;

    return d & ~dipswitches;
}

/* V-Liner system buttons. */
static unsigned shim_poll_sys_vliner(void) {
    unsigned b = 0xff;
    uint32_t m = input_btn[0];

    if (input_sys & 0x01) b &= ~(1 << 0); /* Coin 1 */
    if (input_sys & 0x02) b &= ~(1 << 1); /* Coin 2 */

    if (m & (1u << 8))  b &= ~(1 << 4);  /* Operator Menu */
    if (m & (1u << 9))  b &= ~(1 << 5);  /* Clear Credit */
    if (m & (1u << 10)) b &= ~(1 << 7);  /* Hopper Out */

    return b;
}

static unsigned shim_poll_sys_none(void) {
    return 0xff;
}

/* Wire input callbacks for the effective device set, mirroring jg.c's
   geo_params_input(). Called at setup and again after ROM load (when the
   .neo database flags for special controllers become known). */
static void shim_params_input(void) {
    uint32_t dbflags = geo_neo_flags();
    dipswitches = 0;

    geo_input_set_callback(0, shim_poll_js);
    geo_input_set_callback(1, shim_poll_js);
    geo_input_sys_set_callback(0, shim_poll_stat_a);
    geo_input_sys_set_callback(1, shim_poll_stat_b);
    geo_input_sys_set_callback(2, shim_poll_systype);
    geo_input_sys_set_callback(3, shim_poll_dipsw);
    geo_input_sys_set_callback(4, shim_poll_sys_none);

    if ((cfg_input_mode == INPUT_MODE_MAHJONG) ||
        ((dbflags & GEO_DB_MAHJONG) && cfg_input_mode == INPUT_MODE_AUTO)) {
        dipswitches |= 0x04; /* Mahjong mode */
        geo_input_set_callback(0, shim_poll_mahjong);
        geo_input_set_callback(1, shim_poll_none);
        geo_input_sys_set_callback(1, shim_poll_stat_b_mahjong);
    }
    else if (dbflags & GEO_DB_IRRMAZE) {
        if (cfg_system == SYSTEM_MVS) {
            geo_input_set_callback(0, shim_poll_irrmaze);
            geo_input_set_callback(1, shim_poll_irrmaze);
            geo_input_sys_set_callback(1, shim_poll_stat_b_irrmaze);
        }
        else {
            geo_log(GEO_LOG_WRN, "The Irritating Maze needs MVS mode (or the "
                "Universe BIOS joystick cheat)\n");
        }
    }
    else if (dbflags & GEO_DB_VLINER) {
        geo_input_set_callback(0, shim_poll_vliner);
        geo_input_set_callback(1, shim_poll_none);
        geo_input_sys_set_callback(0, shim_poll_stat_a_vliner);
        geo_input_sys_set_callback(1, shim_poll_stat_b_vliner);
        geo_input_sys_set_callback(4, shim_poll_sys_vliner);
    }
    else if (cfg_input_mode == INPUT_MODE_4P && cfg_system == SYSTEM_MVS &&
        (cfg_region == REGION_AS || cfg_region == REGION_JP)) {
        dipswitches |= 0x02; /* Four Player mode */
        geo_input_set_callback(0, shim_poll_js_ftc1b);
        geo_input_set_callback(1, shim_poll_js_ftc1b);
        geo_input_sys_set_callback(1, shim_poll_stat_b_ftc1b);
    }
}

/* -------------------------------------------------------------------- log */

static void shim_log(int level, const char *fmt, ...) {
    char line[512];
    va_list va;
    va_start(va, fmt);
    vsnprintf(line, sizeof(line), fmt, va);
    va_end(va);

    if (level >= GEO_LOG_WRN)
        fprintf(stderr, "[geolith:%d] %s", level, line);
    else
        printf("[geolith:%d] %s", level, line);
}

/* ---------------------------------------------------------------- exports */

/* Configure and initialize the core. Mirrors the jg_game_load() ordering:
   region/system → adpcm → mixer rate/init → palette → geo_init.

   `system` accepts all geo.h SYSTEM_* values including the CD variants
   (CDF=3, CDT=4, CDZ=5, CDU=6). `unihw` (SYSTEM_AES or SYSTEM_MVS) selects
   which hardware the Universe BIOS should detect.

   `samplerate` is the AudioContext's output rate. The core's YM2610 rate
   constant (56319 ≈ rate * 60/framerate) bakes in a 60Hz frame assumption,
   so the mixer emits rate/60 stereo frames per exec; requesting
   samplerate * 60/framerate makes each exec produce samplerate/framerate
   device frames — exactly one video frame's worth of audio (this mirrors
   upstream jg.c's SAMPLERATE_ADJUSTED). */
KEEPALIVE void geowasm_setup(int system, int region, int samplerate,
    int unihw) {
    /* Match geo_mixer_init(): only MVS/UNI run at the MVS rate; AES and all
       CD systems use the AES rate. */
    double framerate = (system == SYSTEM_MVS || system == SYSTEM_UNI)
        ? FRAMERATE_MVS : FRAMERATE_AES;
    size_t mixrate = (size_t)((double)samplerate * 60.0 / framerate + 0.5);

    cfg_system = system;
    cfg_region = region;
    cfg_unihw = unihw;

    geo_log_set_callback(shim_log);

    geo_set_region(region);
    geo_set_system(system);
    geo_set_adpcm_wrap(1);

    geo_mixer_set_rate(mixrate);
    geo_mixer_init();
    geo_mixer_set_buffer(abuf);
    geo_mixer_set_callback(shim_mixer_cb);

    geo_lspc_set_palette(0); /* resistor network palette */
    geo_lspc_set_buffer(vbuf);

    geo_init();
    geo_set_region(region);

    shim_params_input();

    /* Geolith never drives MVS coin slots 3/4; their active-low REG_STATUS_A
       bits must idle high on MVS-like hardware (see upstream jg.c). */
    if (system == SYSTEM_MVS ||
        (system == SYSTEM_UNI && unihw == SYSTEM_MVS))
        coins34 = 0x18;
    else
        coins34 = 0x00;
}

/* Load a MAME-format BIOS zip (aes.zip / neogeo.zip / neocd*.zip) from
   memory. The zip is extracted to the core's own heap; the caller may free
   `data` afterwards. Returns 1 on success. */
KEEPALIVE int geowasm_load_bios(void *data, size_t size) {
    return geo_bios_load_mem(data, size);
}

/* Load an auxiliary BIOS zip: neocdz.zip (000-lo.lo for CD front/top
   loaders) or irrmaze.zip (The Irritating Maze). Returns 1 on success. */
KEEPALIVE int geowasm_load_bios_aux(void *data, size_t size) {
    return geo_bios_load_mem_aux(data, size);
}

/* Load a .neo cartridge image. The core aliases ROM regions directly into
   `data`, so the buffer must remain allocated for the whole session.
   Re-wires input callbacks afterwards (special-controller flags become
   known here). Returns 1 on success. */
KEEPALIVE int geowasm_load_rom(void *data, size_t size) {
    int ret = geo_neo_load(data, size);
    if (ret)
        shim_params_input();
    return ret;
}

/* Database flags of the loaded game (mahjong/irrmaze/vliner specials). */
KEEPALIVE uint32_t geowasm_neo_flags(void) {
    return geo_neo_flags();
}

/* ------------------------------------------------------------------ CD */

/* Unpack a zip of disc files (.cue + .bin) into MEMFS /disc/. Nested paths
   are flattened to basenames so the cue's file references resolve.
   Returns the number of files extracted, 0 on failure. */
KEEPALIVE int geowasm_disc_unzip(void *data, size_t size) {
    mz_zip_archive zip;
    memset(&zip, 0, sizeof(zip));
    if (!mz_zip_reader_init_mem(&zip, data, size, 0))
        return 0;

    mkdir("/disc", 0777);
    int extracted = 0;
    mz_uint n = mz_zip_reader_get_num_files(&zip);
    for (mz_uint i = 0; i < n; ++i) {
        mz_zip_archive_file_stat st;
        if (!mz_zip_reader_file_stat(&zip, i, &st))
            continue;
        if (st.m_is_directory)
            continue;

        size_t fsz = 0;
        void *fdata = mz_zip_reader_extract_to_heap(&zip, i, &fsz, 0);
        if (!fdata)
            continue;

        const char *base = strrchr(st.m_filename, '/');
        base = base ? base + 1 : st.m_filename;

        char path[512];
        snprintf(path, sizeof(path), "/disc/%s", base);
        FILE *f = fopen(path, "wb");
        if (f) {
            fwrite(fdata, 1, fsz, f);
            fclose(f);
            extracted++;
        }
        free(fdata);
    }

    mz_zip_reader_end(&zip);
    return extracted;
}

/* Open a disc image previously unpacked to /disc/ (pass the cue basename,
   e.g. "game.cue") and finalize CD bring-up. Returns 1 on success. */
KEEPALIVE int geowasm_disc_open(const char *cuename) {
    char path[512];
    snprintf(path, sizeof(path), "/disc/%s", cuename);
    if (!geo_disc_open(path))
        return 0;
    geo_cd_postload();
    return 1;
}

/* Find the first .cue in /disc/ and open it. Returns 1 on success. */
KEEPALIVE int geowasm_disc_open_auto(void) {
    DIR *dir = opendir("/disc");
    if (!dir)
        return 0;

    char cuename[256] = { 0 };
    struct dirent *ent;
    while ((ent = readdir(dir)) != NULL) {
        const char *dot = strrchr(ent->d_name, '.');
        if (dot && !strcasecmp(dot, ".cue")) {
            snprintf(cuename, sizeof(cuename), "%s", ent->d_name);
            break;
        }
    }
    closedir(dir);

    if (!cuename[0]) {
        geo_log(GEO_LOG_ERR, "No .cue file found in disc image\n");
        return 0;
    }
    return geowasm_disc_open(cuename);
}

/* Power-on reset. Call after BIOS+ROM/disc are loaded (the 68K fetches its
   reset vectors from mapped ROM). */
KEEPALIVE void geowasm_reset(int hard) {
    trackball_x = trackball_y = 0;
    geo_reset(hard);
}

/* Run one frame. Returns the number of int16 audio values now in abuf. */
KEEPALIVE int geowasm_exec(void) {
    audio_samps = 0;
    geo_exec();
    return (int)audio_samps;
}

/* Skip rendering for frames the host will not display (catch-up frames). */
KEEPALIVE void geowasm_skip_render(int skip) {
    geo_lspc_set_skip_render((unsigned)skip);
}

/* Convert the visible crop of the XRGB frame to packed RGBA and return it. */
KEEPALIVE uint8_t* geowasm_frame_rgba(int x, int y, int w, int h) {
    uint32_t *dst = rgbabuf;
    for (int line = 0; line < h; ++line) {
        const uint32_t *src = &vbuf[(y + line) * LSPC_WIDTH + x];
        for (int col = 0; col < w; ++col) {
            uint32_t v = src[col];
            dst[col] = 0xff000000u |            /* A */
                ((v & 0x000000ffu) << 16) |     /* B */
                (v & 0x0000ff00u) |             /* G */
                ((v >> 16) & 0x000000ffu);      /* R */
        }
        dst += w;
    }
    return (uint8_t*)rgbabuf;
}

KEEPALIVE int16_t* geowasm_audio_ptr(void) {
    return abuf;
}

/* Set controller state for a player (active-high mask, see input_btn docs). */
KEEPALIVE void geowasm_input(int port, uint32_t mask) {
    if (port >= 0 && port < 4)
        input_btn[port] = mask;
}

/* Set system-button state: bit 0 coin1, 1 coin2, 2 service, 3 test. */
KEEPALIVE void geowasm_input_sys(uint32_t mask) {
    input_sys = mask;
}

/* Relative trackball movement for this frame (The Irritating Maze). */
KEEPALIVE void geowasm_input_axis(int dx, int dy) {
    axis_x = dx;
    axis_y = dy;
}

/* Select the input device mode (INPUT_MODE_*). Rewires callbacks. */
KEEPALIVE void geowasm_set_input_mode(int mode) {
    cfg_input_mode = mode;
    shim_params_input();
}

KEEPALIVE void geowasm_set_dips(int freeplay, int settingmode) {
    dip_freeplay = (uint32_t)freeplay;
    dip_settingmode = (uint32_t)settingmode;
}

KEEPALIVE void geowasm_set_memcard(int inserted, int wp) {
    memcard_inserted = (uint32_t)inserted;
    memcard_wp = (uint32_t)wp;
}

/* Raw palette (1) vs resistor network palette (0, default). */
KEEPALIVE void geowasm_set_palette(int raw) {
    geo_lspc_set_palette(raw);
}

/* ADPCM accumulator wrap hack (default on; off fixes e.g. Ganryu SFX). */
KEEPALIVE void geowasm_set_adpcm_wrap(int wrap) {
    geo_set_adpcm_wrap(wrap);
}

/* Overclock: disable the 68K clock divider. */
KEEPALIVE void geowasm_set_overclock(int oc) {
    geo_set_div68k(!oc);
}

/* ------------------------------------------------------------ save states */

KEEPALIVE size_t geowasm_state_size(void) {
    return geo_state_size();
}

KEEPALIVE const void* geowasm_state_save(void) {
    return geo_state_save_raw();
}

KEEPALIVE int geowasm_state_load(const void *data) {
    return geo_state_load_raw(data);
}

/* -------------------------------------------------------------- save data */

/* Direct views into battery-backed regions for host-side persistence.
   type: enum geo_memtype (NVRAM=4, CARTRAM=5, MEMCARD=7, CDBRAM=9). */
KEEPALIVE const void* geowasm_mem_ptr(unsigned type, size_t *size_out) {
    return geo_mem_ptr(type, size_out);
}

/* Convenience wrappers that avoid passing an out-pointer from JS. */
static size_t memsize_scratch = 0;

KEEPALIVE const void* geowasm_savedata_ptr(unsigned type) {
    memsize_scratch = 0;
    return geo_mem_ptr(type, &memsize_scratch);
}

KEEPALIVE size_t geowasm_savedata_size(void) {
    return memsize_scratch;
}

/* Copy externally persisted bytes back into a battery-backed region. */
KEEPALIVE int geowasm_savedata_restore(unsigned type, const void *data,
    size_t size) {
    size_t regionsz = 0;
    void *region = (void*)geo_mem_ptr(type, &regionsz);
    if (!region || !regionsz || size != regionsz)
        return 0;
    memcpy(region, data, size);
    return 1;
}

KEEPALIVE unsigned geowasm_cartram_present(void) {
    return geo_cartram_present();
}

KEEPALIVE int geowasm_get_system(void) {
    return geo_get_system();
}
