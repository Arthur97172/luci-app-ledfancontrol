#
# Copyright (C) 2026 Arthur97172 <arthur97172@outlook.com>
#
# This is free software, licensed under the GNU General Public License v3.0
# (SPDX: GPL-3.0-only).
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-ledfancontrol
PKG_VERSION:=1.0.0
PKG_RELEASE:=5

PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=Arthur97172 <Arthur97172@users.noreply.github.com>

LUCI_TITLE:=LuCI app for the factory RGB LED and the cooling fan (LED & Fan Control)
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all
LUCI_URL:=https://github.com/Arthur97172/luci-app-ledfancontrol
LUCI_MAINTAINER:=Arthur97172 <Arthur97172@users.noreply.github.com>

# ---------------------------------------------------------------------------
# Simplified Chinese ships as its own luci-i18n-ledfancontrol-zh-cn package.
#
# luci.mk builds one translation package per directory under ./po, but only for
# directory names that also appear in its built-in LUCI_LANG.* table: luci.mk
# collects the directory names into LUCI_LANGUAGES and emits a LuciTranslation
# package for each one it recognises. The directory is therefore po/zh_Hans -
# the spelling in that table - and luci.mk turns it into
# luci-i18n-ledfancontrol-zh-cn, whose install rule compiles po/zh_Hans/*.po
# with po2lmo into usr/lib/lua/luci/i18n/ and ships a uci-defaults that
# registers 简体中文 in luci.languages.
#
# The catalog is named ledfancontrol.zh-cn.lmo rather than
# ledfancontrol.zh_Hans.lmo because LUCI_LC_ALIAS.zh_Hans=zh-cn supplies the
# tag LuCI itself uses for the compiled catalog. That name is load bearing:
# the ucode dispatcher loads every *.zh-cn.lmo in that directory, so it must
# not change.
#
# English needs no file at all: LuCI's _() returns the msgid unchanged when no
# translation matches, so the English strings in ledfancontrol.js are their own
# translation. That is also where the package's English name, "LED & Fan
# Control", comes from - it is the msgid translated to 灯光与风扇 here.
# ---------------------------------------------------------------------------

# The translation package would otherwise take its version from luci.mk's
# findrev helper, which derives it from the newest commit touching po/ - and
# falls back to plain file mtimes when there is no git history, as in a CI
# checkout. Pinning it to the release version keeps every package in a release
# telling the same story. luci.mk assigns PKG_PO_VERSION with ?=, so this
# definition is respected, and it also skips findrev during the package scan.
PKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
#
# The line above is load bearing and must not be removed: OpenWrt's package
# scanner discovers package directories by grepping their Makefile for the
# literal text "call BuildPackage" - see GREP_STRING in include/scan.mk and
# the find|xargs grep next to it. Without it the package is silently skipped
# and "make package/luci-app-ledfancontrol/compile" fails with "No rule to
# make target".
#
# Note that the macro itself is *not* invoked here: luci.mk already calls
# BuildPackage for every entry in LUCI_BUILD_PACKAGES, which for this package
# is luci-app-ledfancontrol together with luci-i18n-ledfancontrol-zh-cn. The
# literal text above exists purely so that include/scan.mk can find the
# package directory.
