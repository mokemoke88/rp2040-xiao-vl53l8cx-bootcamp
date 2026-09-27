# SPDX-License-Identifier: MIT
#
# ホスト(PC)側の作業: make test / make format / make lint
# ファームウェアのビルド:  make firmware(CMake + Ninja を呼び出す)
#
# third_party/(ULD、Unity)は整形・検査の対象にしない

CC = gcc
UNITY_DIR = third_party/unity
HOST_BUILD = build-host
CFLAGS = -std=c99 -Wall -Wextra -Wpedantic -Iinclude -I$(UNITY_DIR)

# ファームウェアのビルド設定(make firmware BUILD_DIR=build-foo CMAKE_ARGS=-DFOO=ON のように上書きできる)
BUILD_DIR = build
PICO_BOARD = seeed_xiao_rp2040
CMAKE_ARGS =

# Windows の gcc は実行ファイルに .exe を付けるので、ターゲット名もそれに合わせる
# (合わせないと make がターゲットを見つけられず、毎回再ビルドになる)
ifeq ($(OS),Windows_NT)
EXE = .exe
else
EXE =
endif

FORMAT_FILES = $(wildcard include/*.h src/*.c tests/*.c)

# Pico SDK に依存しない uld_util.c / depth_view.c / frame_proto.c だけをホストでビルドする
# TEST_SMALL: 分割書き込みの塊を小さくした構成。塊の長さを ULD_WRITE_CHUNK_BYTES から計算しているテストが
#             定数を変えても追従することを確かめる
TEST_DEFAULT = $(HOST_BUILD)/test_uld_util$(EXE)
TEST_SMALL = $(HOST_BUILD)/test_uld_util_small$(EXE)
TEST_DEPTH = $(HOST_BUILD)/test_depth_view$(EXE)
TEST_PROTO = $(HOST_BUILD)/test_frame_proto$(EXE)
TESTS = $(TEST_DEFAULT) $(TEST_SMALL) $(TEST_DEPTH) $(TEST_PROTO)
TEST_SRCS = tests/test_uld_util.c src/uld_util.c $(UNITY_DIR)/unity.c
TEST_DEPS = $(TEST_SRCS) include/uld_util.h
DEPTH_SRCS = tests/test_depth_view.c src/depth_view.c src/uld_util.c $(UNITY_DIR)/unity.c
DEPTH_DEPS = $(DEPTH_SRCS) include/depth_view.h include/uld_util.h
PROTO_SRCS = tests/test_frame_proto.c src/frame_proto.c $(UNITY_DIR)/unity.c
PROTO_DEPS = $(PROTO_SRCS) include/frame_proto.h tests/frame_vectors.h

# テストベクタ(docs/frame-vectors.json と tests/frame_vectors.h)を作るスクリプトと、記録の検証スクリプト
PYTHON = python

.PHONY: all test vectors format lint firmware clean

all: test

test: $(TESTS)
	./$(TEST_DEFAULT)
	./$(TEST_SMALL)
	./$(TEST_DEPTH)
	./$(TEST_PROTO)
	$(PYTHON) tools/gen_frame_vectors.py --check
	$(PYTHON) tools/verification/decode_capture.py --self-test

$(TEST_DEFAULT): $(TEST_DEPS) | $(HOST_BUILD)
	$(CC) $(CFLAGS) -o $@ $(TEST_SRCS)

$(TEST_SMALL): $(TEST_DEPS) | $(HOST_BUILD)
	$(CC) $(CFLAGS) -DULD_WRITE_CHUNK_BYTES=7u -o $@ $(TEST_SRCS)

$(TEST_DEPTH): $(DEPTH_DEPS) | $(HOST_BUILD)
	$(CC) $(CFLAGS) -o $@ $(DEPTH_SRCS)

$(TEST_PROTO): $(PROTO_DEPS) | $(HOST_BUILD)
	$(CC) $(CFLAGS) -Itests -o $@ $(PROTO_SRCS)

# テストベクタを作り直す(tools/gen_frame_vectors.py を変えたとき)
vectors:
	$(PYTHON) tools/gen_frame_vectors.py

$(HOST_BUILD):
	mkdir -p $@

format:
	clang-format -i $(FORMAT_FILES)

lint:
	clang-format --dry-run --Werror $(FORMAT_FILES)

firmware:
	cmake -S . -B $(BUILD_DIR) -G Ninja -DPICO_BOARD=$(PICO_BOARD) $(CMAKE_ARGS)
	cmake --build $(BUILD_DIR)

clean:
	rm -rf $(HOST_BUILD)
