/*
 * geo_shim.c — WebAssembly bridge for the Geolith Neo Geo emulator core.
 *
 * Replaces the Jolly Good API frontend (jg.c) with a flat C ABI the JS SDK
 * drives directly: one geowasm_exec() per frame, a static XRGB framebuffer
 * converted to RGBA for canvas upload, a per-frame int16 audio buffer, and
 * bitmask-based input state polled by the core's input callbacks.
 *
 * Everything here mirrors the wiring in upstream jg.c (input bit semantics,
 * init ordering, mixer setup) minus SDL/JG dependencies.
 */

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include "geo.h"
#include "geo_lspc.h"
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

/* Active-high button masks set from JS, one per Neo Geo controller port.
   bit 0..3 = up/down/left/right, bit 4..7 = A/B/C/D,
   bit 8 = start, bit 9 = select. */
static uint32_t input_js[NUMINPUTS_NG] = { 0, 0 };

/* Active-high system mask: bit 0 coin1, 1 coin2, 2 service, 3 test. */
static uint32_t input_sys = 0;

/* Memory card emulation flags (mirrors jg.c settings defaults). */
static uint32_t memcard_inserted = 1;
static uint32_t memcard_wp = 0;

/* DIP switch state (freeplay bit 0x40, setting mode bit 0x01). */
static uint32_t dip_freeplay = 0;
static uint32_t dip_settingmode = 0;

/* Coin slot 3/4 bits for REG_STATUS_A (set high on MVS, see jg.c). */
static unsigned coins34 = 0x00;

/* Controller port poll: active-low hardware bits from active-high JS mask. */
static unsigned shim_poll_js(unsigned port) {
    unsigned b = 0xff;
    uint32_t m = input_js[port & 1];

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

/* REG_STATUS_A: coin slots and service button (active low). */
static unsigned shim_poll_stat_a(void) {
    unsigned c = 0x07;

    if (input_sys & 0x01) c &= 0x06; /* Coin 1 */
    if (input_sys & 0x02) c &= 0x05; /* Coin 2 */
    if (input_sys & 0x04) c &= 0x03; /* Service */

    c |= coins34;

    return c;
}

/* REG_STATUS_B: P1/P2 Start+Select, memory card status. */
static unsigned shim_poll_stat_b(void) {
    unsigned s = 0x0f;

    if (memcard_inserted) {
        if (memcard_wp) s |= 0x40;
    }
    else {
        s |= 0x30;
    }

    if (input_js[0] & 0x200) s &= 0x0d; /* P1 Select */
    if (input_js[0] & 0x100) s &= 0x0e; /* P1 Start */
    if (input_js[1] & 0x200) s &= 0x07; /* P2 Select */
    if (input_js[1] & 0x100) s &= 0x0b; /* P2 Start */

    return s;
}

/* Test button and slot type. */
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

    return d;
}

static unsigned shim_poll_sys_none(void) {
    return 0xff;
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

   `samplerate` is the AudioContext's output rate. The core's YM2610 rate
   constant (56319 ≈ rate * 60/framerate) bakes in a 60Hz frame assumption,
   so the mixer emits rate/60 stereo frames per exec; requesting
   samplerate * 60/framerate makes each exec produce samplerate/framerate
   device frames — exactly one video frame's worth of audio (this mirrors
   upstream jg.c's SAMPLERATE_ADJUSTED). */
KEEPALIVE void geowasm_setup(int system, int region, int samplerate) {
    double framerate =
        (system == SYSTEM_AES) ? FRAMERATE_AES : FRAMERATE_MVS;
    size_t mixrate = (size_t)((double)samplerate * 60.0 / framerate + 0.5);
    geo_log_set_callback(shim_log);

    geo_input_set_callback(0, shim_poll_js);
    geo_input_set_callback(1, shim_poll_js);
    geo_input_sys_set_callback(0, shim_poll_stat_a);
    geo_input_sys_set_callback(1, shim_poll_stat_b);
    geo_input_sys_set_callback(2, shim_poll_systype);
    geo_input_sys_set_callback(3, shim_poll_dipsw);
    geo_input_sys_set_callback(4, shim_poll_sys_none);

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

    /* Geolith never drives MVS coin slots 3/4; their active-low REG_STATUS_A
       bits must idle high on MVS-like hardware (see upstream jg.c). */
    if (system == SYSTEM_MVS || system == SYSTEM_UNI)
        coins34 = 0x18;
    else
        coins34 = 0x00;
}

/* Load a MAME-format BIOS zip (aes.zip / neogeo.zip) from memory.
   The zip is extracted to the core's own heap; the caller may free `data`
   afterwards. Returns 1 on success. */
KEEPALIVE int geowasm_load_bios(void *data, size_t size) {
    return geo_bios_load_mem(data, size);
}

/* Load a .neo cartridge image. The core aliases ROM regions directly into
   `data`, so the buffer must remain allocated for the whole session.
   Returns 1 on success. */
KEEPALIVE int geowasm_load_rom(void *data, size_t size) {
    return geo_neo_load(data, size);
}

/* Database flags of the loaded game (mahjong/irrmaze/vliner specials). */
KEEPALIVE uint32_t geowasm_neo_flags(void) {
    return geo_neo_flags();
}

/* Power-on reset. Call after BIOS+ROM are loaded (the 68K fetches its reset
   vectors from mapped ROM). */
KEEPALIVE void geowasm_reset(int hard) {
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

/* Set controller state for a port (active-high mask, see input_js docs). */
KEEPALIVE void geowasm_input(int port, uint32_t mask) {
    if (port >= 0 && port < NUMINPUTS_NG)
        input_js[port] = mask;
}

/* Set system-button state: bit 0 coin1, 1 coin2, 2 service, 3 test. */
KEEPALIVE void geowasm_input_sys(uint32_t mask) {
    input_sys = mask;
}

KEEPALIVE void geowasm_set_dips(int freeplay, int settingmode) {
    dip_freeplay = (uint32_t)freeplay;
    dip_settingmode = (uint32_t)settingmode;
}

KEEPALIVE void geowasm_set_memcard(int inserted, int wp) {
    memcard_inserted = (uint32_t)inserted;
    memcard_wp = (uint32_t)wp;
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
   type: enum geo_memtype (NVRAM=4, CARTRAM=5, MEMCARD=7). */
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
