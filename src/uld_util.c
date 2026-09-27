/* SPDX-License-Identifier: MIT */
#include "uld_util.h"

void uld_swap_buffer(uint8_t *buffer, uint32_t size) {
  /* 4 バイトの組 [a b c d] を [d c b a] にする。余りの 1〜3 バイトには触らない */
  for (uint32_t i = 0; i + 4u <= size; i += 4u) {
    const uint8_t b0 = buffer[i];
    const uint8_t b1 = buffer[i + 1u];
    buffer[i] = buffer[i + 3u];
    buffer[i + 1u] = buffer[i + 2u];
    buffer[i + 2u] = b1;
    buffer[i + 3u] = b0;
  }
}

uint32_t uld_chunk_len(uint32_t total, uint32_t offset, uint32_t max_chunk) {
  if (offset >= total) return 0;
  const uint32_t remaining = total - offset;
  return remaining < max_chunk ? remaining : max_chunk;
}

uint16_t uld_chunk_reg(uint16_t start_reg, uint32_t offset) {
  return (uint16_t)(start_reg + offset);
}

uint32_t uld_pack_write(uint8_t *dst, uint16_t reg, const uint8_t *data, uint32_t len) {
  dst[0] = (uint8_t)(reg >> 8);
  dst[1] = (uint8_t)(reg & 0xFFu);
  for (uint32_t i = 0; i < len; i++) dst[ULD_REG_ADDR_BYTES + i] = data[i];
  return ULD_REG_ADDR_BYTES + len;
}

bool uld_write_chunked(uint16_t start_reg, const uint8_t *data, uint32_t size, uint8_t *buf, uint32_t max_chunk,
                       uld_send_chunk_fn send, void *ctx) {
  /* max_chunk = 0 では塊が進まず無限ループになるので、何も送らずに失敗にする */
  if (max_chunk == 0u) return false;
  for (uint32_t offset = 0; offset < size;) {
    const uint32_t n = uld_chunk_len(size, offset, max_chunk);
    const uint32_t len = uld_pack_write(buf, uld_chunk_reg(start_reg, offset), data + offset, n);
    if (!send(ctx, buf, len)) return false;
    offset += n;
  }
  return true;
}

uint32_t uld_i2c_timeout_us(uint32_t nbytes) {
  const uint32_t limit = (UINT32_MAX - ULD_I2C_TIMEOUT_BASE_US) / ULD_I2C_TIMEOUT_PER_BYTE_US;
  if (nbytes > limit) return UINT32_MAX;
  return ULD_I2C_TIMEOUT_BASE_US + nbytes * ULD_I2C_TIMEOUT_PER_BYTE_US;
}

bool uld_target_status_is_valid(uint8_t status) {
  return status == 5u || status == 9u;
}
