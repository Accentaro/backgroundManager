/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Ported from BackgroundManager by Narukami
// Original: https://github.com/Naru-kami/BackgroundManager-plugin

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { clear, createStore, del, entries, get, set } from "@api/DataStore";
import { HeaderBarButton } from "@api/HeaderBar";
import { definePluginSettings, Settings as AppSettings, useSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { CloudUploadIcon, DeleteIcon, ImageIcon, NoEntrySignIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { Switch } from "@components/Switch";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { chooseFile } from "@utils/web";
import type { Message } from "@vencord/discord-types";
import { Alerts, Button, Clickable, Dialog, Menu, Popout, Select, Slider, ThemeStore, Toasts, Tooltip, useCallback, useEffect, useRef, useState } from "@webpack/common";
import type { ComponentProps } from "react";

const cl = classNameFactory("vc-bgmanager-");
const logger = new Logger("BackgroundManager");
const imageStore = createStore("BackgroundManager", "ImageStore");
// Media records use numeric keys; the active selection is a single string key
// so switching backgrounds never rewrites media records.
const ACTIVE_ID_KEY = "activeId";
const DEFAULT_SLIDESHOW_MINUTES = 5;
const MAX_SLIDESHOW_MINUTES = 1440;
const THEME_BACKGROUND_PROP_RE = /background|bg|wallpaper|backdrop/i;
const THEME_IMAGE_PROP_RE = /image|img/i;

// Discord paints its shell surfaces with these design token variables.
// Most surfaces use "var(--background-gradient-X, var(--base-fallback))",
// so while the tint sets every token the gradient ones win and the
// fallback tokens only show on surfaces that use them directly.
const TINT_SURFACES = {
    "--background-gradient-chat": {
        label: "Chat & Member List",
        description: "Chat area, channel header and member list."
    },
    "--background-gradient-high": {
        label: "Channel Sidebar",
        description: "Server and channel list sidebar."
    },
    "--background-gradient-highest": {
        label: "Chat Input & User Panel",
        description: "Chat input bar, user panel and boost goal progress."
    },
    "--background-base-lowest": {
        label: "Server Bar & Title Bar",
        description: "Server (guild) bar and the window title bar."
    },
    "--background-base-lower": {
        label: "Settings Pages",
        description: "Settings page surfaces; elsewhere a fallback under Chat & Member List."
    },
    "--background-base-low": {
        label: "Settings Sidebar",
        description: "Settings page surfaces; elsewhere a fallback under Chat Input & User Panel."
    },
    "--background-gradient-low": {
        label: "Search Bar & Forum Pills",
        description: "Search bar, forum topic pills and the scheduled message bar."
    },
    "--background-gradient-lower": {
        label: "Themed Title Bar (Dark)",
        description: "Themed channel title bar in dark mode and the forum sidebar."
    },
    "--background-gradient-lowest": {
        label: "Themed Title Bar (Light)",
        description: "Themed channel title bar in light mode, search results and forum panels."
    },
    "--chat-background-default": {
        label: "Profile Sidebar",
        description: "User profile side panel and its banner; also the chat input fallback."
    }
} as const;

type TintVariable = keyof typeof TINT_SURFACES;

const DEFAULT_TINT_OPACITY = 20;

function buildAppTintCss() {
    const tints = settings.store.tints ?? {};
    const declarations = (Object.keys(TINT_SURFACES) as TintVariable[])
        .map(variable => `    ${variable}: rgb(0 0 0 / ${tints[variable] ?? DEFAULT_TINT_OPACITY}%);`)
        .join("\n");

    return `body, body :is(.theme-dark, .theme-light) {\n${declarations}\n}`;
}

type MediaKind = "image" | "video";
type ThemeMode = "light" | "dark";

interface StoredMedia {
    blob: Blob;
    width: number;
    height: number;
    kind: MediaKind;
}

interface MediaItem extends StoredMedia {
    id: number;
    src: string;
    selected: boolean;
}

interface MediaSize {
    width: number;
    height: number;
}

interface ThemeCssTarget {
    property: string;
    selector: string;
}

interface ImageContextProps {
    src?: string;
}

type MessageContextTarget =
    Pick<HTMLElement, "dataset" | "tagName">
    & Partial<Pick<HTMLAnchorElement, "href">>
    & Partial<Pick<HTMLMediaElement, "currentSrc" | "src">>;

interface MessageContextProps {
    mediaItem?: {
        contentType?: string;
        url?: string;
    };
    message?: Message;
    target?: MessageContextTarget;
}

type RuleWithChildren = CSSRule & {
    cssRules?: CSSRuleList;
};

let mediaItems: MediaItem[] = [];
let startGeneration = 0;
let activeLayerIdx = 0;
let currentMedia: MediaItem | null = null;
let layerMedia: [MediaItem | null, MediaItem | null] = [null, null];
let slideshowTimer: ReturnType<typeof setInterval> | null = null;
let visCleanup: (() => void) | null = null;

const uiListeners = new Set<() => void>();
const themeCssTargetCache = new Map<string, ThemeCssTarget[]>();

function notifyUI() {
    uiListeners.forEach(listener => listener());
}

function showFailureToast(message: string) {
    Toasts.show({
        id: Toasts.genId(),
        message,
        type: Toasts.Type.FAILURE
    });
}

function showSuccessToast(message: string) {
    Toasts.show({
        id: Toasts.genId(),
        message,
        type: Toasts.Type.SUCCESS
    });
}

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function handleStoreWriteError(action: string) {
    return (error: unknown) => {
        logger.error(`Failed to ${action}`, error);
        showFailureToast(`Failed to ${action}: ${getErrorMessage(error)}`);
    };
}

function inferMediaKind(blob: Blob): MediaKind | null {
    if (blob.type.startsWith("image/")) return "image";
    if (blob.type === "video/mp4") return "video";
    return null;
}

function probeImageSize(src: string) {
    return new Promise<MediaSize | null>(resolve => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve(null);
        image.src = src;
    });
}

function probeVideoSize(src: string) {
    return new Promise<MediaSize | null>(resolve => {
        const video = document.createElement("video");
        const settle = (size: MediaSize | null) => {
            video.removeAttribute("src");
            video.load();
            resolve(size);
        };

        video.preload = "metadata";
        video.muted = true;
        video.onloadedmetadata = () => settle({ width: video.videoWidth, height: video.videoHeight });
        video.onerror = () => settle(null);
        video.src = src;
    });
}

function parseStoredMedia(value: unknown): StoredMedia | null {
    if (typeof value !== "object" || value === null) return null;

    const { blob, width, height, kind } = value as Record<string, unknown>;
    if (!(blob instanceof Blob)) return null;
    if (typeof width !== "number" || !Number.isFinite(width)) return null;
    if (typeof height !== "number" || !Number.isFinite(height)) return null;

    const mediaKind = kind === "image" || kind === "video" ? kind : inferMediaKind(blob);
    if (!mediaKind) return null;

    return { blob, width, height, kind: mediaKind };
}

async function loadFromDB(): Promise<MediaItem[]> {
    try {
        const all = await entries<number | string, unknown>(imageStore);
        const items: MediaItem[] = [];

        for (const [id, value] of all) {
            if (typeof id !== "number") continue;

            const stored = parseStoredMedia(value);
            if (!stored) {
                logger.warn(`Skipping invalid stored media record ${String(id)}`);
                continue;
            }

            items.push({
                ...stored,
                id,
                src: URL.createObjectURL(stored.blob),
                selected: false
            });
        }

        return items.sort((left, right) => left.id - right.id);
    } catch (error) {
        logger.error("Failed to load stored media", error);
        return [];
    }
}

async function addMedia(blob: Blob): Promise<MediaItem | null> {
    const kind = inferMediaKind(blob);
    if (!kind) return null;

    const src = URL.createObjectURL(blob);
    const size = kind === "image" ? await probeImageSize(src) : await probeVideoSize(src);
    if (!size) {
        URL.revokeObjectURL(src);
        return null;
    }

    const id = mediaItems.length > 0 ? Math.max(...mediaItems.map(item => item.id)) + 1 : 0;
    const stored: StoredMedia = { blob, width: size.width, height: size.height, kind };

    try {
        await set(id, stored, imageStore);
    } catch (error) {
        URL.revokeObjectURL(src);
        throw error;
    }

    const item: MediaItem = { ...stored, id, src, selected: false };
    mediaItems.push(item);
    notifyUI();
    return item;
}

function removeMedia(id: number) {
    const media = mediaItems.find(item => item.id === id);
    if (!media) return;

    URL.revokeObjectURL(media.src);
    mediaItems = mediaItems.filter(item => item.id !== id);
    del(id, imageStore).catch(handleStoreWriteError("delete stored background"));

    if (media.selected) {
        del(ACTIVE_ID_KEY, imageStore).catch(handleStoreWriteError("clear background selection"));
        removeBackground();
    } else {
        notifyUI();
    }
}

function selectMedia(id: number) {
    const media = mediaItems.find(item => item.id === id);
    // Skip when already displayed, so reselecting does not replay the crossfade.
    if (!media || media === currentMedia) return;

    if (!media.selected) {
        for (const item of mediaItems) {
            item.selected = item.id === id;
        }
        set(ACTIVE_ID_KEY, id, imageStore).catch(handleStoreWriteError("save background selection"));
    }

    setBackground(media);
}

function deselectAll() {
    mediaItems.forEach(media => {
        media.selected = false;
    });

    del(ACTIVE_ID_KEY, imageStore).catch(handleStoreWriteError("clear background selection"));
    removeBackground();
}

function setBackground(media: MediaItem) {
    currentMedia = media;
    if (document.visibilityState === "visible") activeLayerIdx ^= 1;
    layerMedia[activeLayerIdx] = media;
    notifyUI();
}

function removeBackground() {
    currentMedia = null;
    layerMedia = [null, null];
    activeLayerIdx = 0;
    notifyUI();
}

function getThemeMode(): ThemeMode | undefined {
    if (!ThemeStore) return undefined;
    return ThemeStore.theme === "light" ? "light" : "dark";
}

function getThemeCssSignature(
    activeThemes: readonly string[],
    activeThemeLinks: readonly string[],
    useQuickCss: boolean
) {
    return [
        String(useQuickCss),
        ...activeThemes,
        "",
        ...activeThemeLinks
    ].join("\0");
}

function shouldApplyTheme(themeId: string, themeMode: ThemeMode | undefined) {
    const mode = AppSettings.themeActivationModes[themeId] ?? "always";
    return mode === "always" || mode === themeMode;
}

// Mirrors the filtering in api/Themes so only the CSS that is actually
// applied gets scanned for background variables. Like there, the legacy
// @light/@dark link prefix is stripped and activation modes decide.
function getActiveThemeSources(
    enabledThemes: readonly string[],
    enabledThemeLinks: readonly string[],
    themeMode: ThemeMode | undefined
) {
    return {
        themes: enabledThemes.filter(theme => shouldApplyTheme(theme, themeMode)),
        links: enabledThemeLinks
            .filter(link => shouldApplyTheme(link, themeMode))
            .map(link => /^@(?:light|dark) (.*)/.exec(link)?.[1] ?? link)
    };
}

async function fetchCssSource(url: string) {
    try {
        const response = await fetch(url);
        if (!response.ok) return "";
        return await response.text();
    } catch {
        return "";
    }
}

async function resolveCssImports(css: string, baseUrl?: string, seen = new Set<string>()) {
    const imports = Array.from(css.matchAll(/@import\s+(?:url\(\s*)?(?:(["'])(.*?)\1|([^"')\s;]+))\s*\)?[^;]*;/gi));
    if (imports.length === 0) return css;

    let resolvedCss = "";
    let lastIndex = 0;

    for (const match of imports) {
        const index = match.index ?? 0;
        resolvedCss += css.slice(lastIndex, index);
        lastIndex = index + match[0].length;

        const specifier = match[2] ?? match[3];
        if (!specifier) continue;

        let importUrl: string;
        try {
            importUrl = new URL(specifier, baseUrl).toString();
        } catch {
            continue;
        }

        if (seen.has(importUrl)) continue;
        seen.add(importUrl);

        const importedCss = await fetchCssSource(importUrl);
        if (!importedCss) continue;

        resolvedCss += await resolveCssImports(importedCss, importUrl, seen);
    }

    resolvedCss += css.slice(lastIndex);
    return resolvedCss;
}

async function loadThemeCssSources(
    activeThemes: readonly string[],
    activeThemeLinks: readonly string[],
    useQuickCss: boolean
) {
    const cssSources: string[] = [];

    if (useQuickCss) {
        const quickCss = await VencordNative.quickCss.get();
        if (quickCss.trim().length > 0) {
            cssSources.push(await resolveCssImports(quickCss));
        }
    }

    const onlineThemes = await Promise.all(activeThemeLinks.map(async link => {
        const css = await fetchCssSource(link);
        if (!css) return "";
        return resolveCssImports(css, link, new Set([link]));
    }));

    const localThemes = await Promise.all(activeThemes.map(async theme => {
        if (IS_WEB) {
            const css = await VencordNative.themes.getThemeData(theme);
            return css ? resolveCssImports(css) : "";
        }

        // The same protocol URL the theme loader uses (see api/Themes), so
        // relative @imports resolve exactly like they do in the applied theme.
        const themeUrl = `vencord:///themes/${theme}?v=${Date.now()}`;
        const css = await fetchCssSource(themeUrl);
        return css ? resolveCssImports(css, themeUrl, new Set([themeUrl])) : "";
    }));

    cssSources.push(...[...onlineThemes, ...localThemes].filter(css => css.trim().length > 0));
    return cssSources;
}

function getStyleProperties(style: CSSStyleDeclaration) {
    return Array.from({ length: style.length }, (_, index) => style.item(index));
}

function pickThemeCssTargets(targets: Map<string, ThemeCssTarget>) {
    const properties = Array.from(targets.keys());
    const selectedProperty = properties.length === 1
        ? properties[0]
        : properties.find(property => THEME_BACKGROUND_PROP_RE.test(property))
        ?? properties.find(property => THEME_IMAGE_PROP_RE.test(property));

    return selectedProperty ? [targets.get(selectedProperty)!] : [];
}

function collectThemeCssTargets(rules: CSSRuleList, targets: Map<string, ThemeCssTarget>) {
    for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
            for (const property of getStyleProperties(rule.style)) {
                const value = rule.style.getPropertyValue(property).trim();
                if (!property.startsWith("--") || !value.startsWith("url")) continue;

                targets.set(property, {
                    property,
                    selector: rule.selectorText ?? ":root"
                });
            }
            continue;
        }

        const nestedRules = (rule as RuleWithChildren).cssRules;
        if (nestedRules) collectThemeCssTargets(nestedRules, targets);
    }
}

function parseThemeCssTargetsFromText(css: string) {
    const targets = new Map<string, ThemeCssTarget>();

    for (const block of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
        const trimmedSelector = block[1].trim();
        const selector = trimmedSelector.length > 0 ? trimmedSelector : ":root";

        for (const declaration of block[2].matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*url\([^;]+?\)/g)) {
            const property = declaration[1];
            targets.set(property, { property, selector });
        }
    }

    return pickThemeCssTargets(targets);
}

async function parseThemeCssTargets(css: string) {
    try {
        const sheet = new CSSStyleSheet();
        await sheet.replace(css);

        const targets = new Map<string, ThemeCssTarget>();
        collectThemeCssTargets(sheet.cssRules, targets);
        return pickThemeCssTargets(targets);
    } catch {
        return parseThemeCssTargetsFromText(css);
    }
}

async function getThemeCssTargets(
    activeThemes: readonly string[],
    activeThemeLinks: readonly string[],
    useQuickCss: boolean
) {
    const signature = getThemeCssSignature(activeThemes, activeThemeLinks, useQuickCss);
    const cachedTargets = themeCssTargetCache.get(signature);
    if (cachedTargets) return cachedTargets;

    const cssSources = await loadThemeCssSources(activeThemes, activeThemeLinks, useQuickCss);
    const targets = (await Promise.all(cssSources.map(parseThemeCssTargets))).flat();
    themeCssTargetCache.set(signature, targets);
    return targets;
}

function getSlideshowIntervalMinutes() {
    const minutes = settings.store.slideshowInterval;
    if (typeof minutes !== "number" || !Number.isFinite(minutes)) return DEFAULT_SLIDESHOW_MINUTES;
    return Math.min(Math.max(Math.round(minutes), 1), MAX_SLIDESHOW_MINUTES);
}

function startSlideshow() {
    stopSlideshow();
    if (!settings.store.enableSlideshow || mediaItems.length < 2) return;

    let hidden = false;
    const onVisibilityChange = () => {
        if (document.visibilityState === "visible") hidden = false;
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    visCleanup = () => document.removeEventListener("visibilitychange", onVisibilityChange);
    slideshowTimer = setInterval(() => {
        if (document.visibilityState === "hidden") {
            if (hidden) return;
            hidden = true;
        }

        nextImage();
    }, getSlideshowIntervalMinutes() * 60_000);
}

function stopSlideshow() {
    if (slideshowTimer) {
        clearInterval(slideshowTimer);
        slideshowTimer = null;
    }

    visCleanup?.();
    visCleanup = null;
}

function nextImage() {
    if (mediaItems.length < 2) return;

    const currentIndex = mediaItems.findIndex(item => item.selected);
    let nextIndex: number;

    if (settings.store.shuffleSlideshow || currentIndex === -1) {
        let attempts = 0;
        do {
            nextIndex = Math.floor(Math.random() * mediaItems.length);
        } while (nextIndex === currentIndex && attempts++ < 25);
    } else {
        nextIndex = (currentIndex + 1) % mediaItems.length;
    }

    selectMedia(mediaItems[nextIndex].id);
}

function formatSize(bytes: number) {
    const units = ["B", "KiB", "MiB", "GiB"];
    let unitIndex = 0;

    while (bytes >= 1024 && unitIndex < units.length - 1) {
        bytes /= 1024;
        unitIndex++;
    }

    return `${unitIndex > 0 ? bytes.toFixed(1) : String(bytes)} ${units[unitIndex]}`;
}

async function fetchAndAddMedia(src: string) {
    try {
        const url = new URL(src);
        if (url.origin === "https://media.discordapp.net") {
            url.host = "cdn.discordapp.com";
            for (const param of ["size", "width", "height", "quality", "format"]) {
                url.searchParams.delete(param);
            }
        }

        const response = await fetch(url.toString(), { mode: "cors" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const blob = await response.blob();
        const item = await addMedia(blob);
        if (!item) {
            throw new Error("Only images and MP4 videos are supported");
        }

        showSuccessToast("Added to Background Manager");
    } catch (error) {
        showFailureToast(`Failed to add background media: ${getErrorMessage(error)}`);
    }
}

function makeSliderProps(labelStep: number) {
    return {
        onMarkerRender: (value: number) => value % labelStep === 0 ? String(value) : "",
        onValueRender: (value: number) => String(value)
    };
}

function TintSettings() {
    const [selectedVariable, setSelectedVariable] = useState<TintVariable>("--background-gradient-chat");
    const tints = settings.store.tints ?? {};

    return (
        <div className={cl("tint-settings")}>
            <Heading>Surface Tints</Heading>
            <Paragraph className={cl("tint-note")}>
                Opacity of the dark tint layered over each app surface while a background is active.
            </Paragraph>
            <Select
                options={Object.entries(TINT_SURFACES).map(([value, { label }]) => ({ value, label }))}
                maxVisibleItems={5}
                closeOnSelect={true}
                select={setSelectedVariable}
                isSelected={value => value === selectedVariable}
                serialize={value => String(value)}
            />
            <Paragraph className={cl("tint-note")}>
                {TINT_SURFACES[selectedVariable].description} ({selectedVariable})
            </Paragraph>
            <Slider
                key={selectedVariable}
                markers={makeRange(0, 100, 5)}
                minValue={0}
                maxValue={100}
                initialValue={tints[selectedVariable] ?? DEFAULT_TINT_OPACITY}
                onValueChange={value => {
                    settings.store.tints = { ...settings.store.tints, [selectedVariable]: Math.round(value) };
                }}
                {...makeSliderProps(25)}
            />
        </div>
    );
}

const settings = definePluginSettings({
    enableTransition: {
        type: OptionType.BOOLEAN,
        description: "Enable smooth crossfade transitions between backgrounds.",
        default: true,
        onChange: notifyUI
    },
    transitionDuration: {
        type: OptionType.NUMBER,
        description: "Transition duration in milliseconds.",
        default: 1000,
        componentProps: { inputClassName: cl("number-input") },
        onChange: notifyUI
    },
    enableSlideshow: {
        type: OptionType.BOOLEAN,
        description: "Auto-cycle through backgrounds at the configured interval.",
        default: false,
        onChange: enabled => enabled ? startSlideshow() : stopSlideshow()
    },
    slideshowInterval: {
        type: OptionType.NUMBER,
        description: "Slideshow interval in minutes (1-1440).",
        default: DEFAULT_SLIDESHOW_MINUTES,
        componentProps: { inputClassName: cl("number-input") },
        onChange: () => {
            if (settings.store.enableSlideshow) startSlideshow();
        }
    },
    shuffleSlideshow: {
        type: OptionType.BOOLEAN,
        description: "Randomize slideshow order.",
        default: true
    },
    overwriteCSS: {
        type: OptionType.BOOLEAN,
        description: "Auto-detect and overwrite theme background CSS variables.",
        default: true,
        onChange: notifyUI
    },
    xPosition: {
        type: OptionType.SLIDER,
        description: "Horizontal position offset (%).",
        default: 0,
        markers: makeRange(-50, 50, 5),
        componentProps: makeSliderProps(25),
        onChange: notifyUI
    },
    yPosition: {
        type: OptionType.SLIDER,
        description: "Vertical position offset (%).",
        default: 0,
        markers: makeRange(-50, 50, 5),
        componentProps: makeSliderProps(25),
        onChange: notifyUI
    },
    dimming: {
        type: OptionType.SLIDER,
        description: "Background dimming (%).",
        default: 0,
        markers: makeRange(0, 100, 5),
        componentProps: makeSliderProps(25),
        onChange: notifyUI
    },
    blur: {
        type: OptionType.SLIDER,
        description: "Background blur (px).",
        default: 0,
        markers: makeRange(0, 100, 5),
        componentProps: makeSliderProps(25),
        onChange: notifyUI
    },
    grayscale: {
        type: OptionType.SLIDER,
        description: "Grayscale filter (%).",
        default: 0,
        markers: makeRange(0, 100, 5),
        componentProps: makeSliderProps(25),
        onChange: notifyUI
    },
    saturate: {
        type: OptionType.SLIDER,
        description: "Saturation (%).",
        default: 100,
        markers: makeRange(0, 300, 5),
        componentProps: makeSliderProps(50),
        onChange: notifyUI
    },
    contrast: {
        type: OptionType.SLIDER,
        description: "Contrast (%).",
        default: 100,
        markers: makeRange(0, 300, 5),
        componentProps: makeSliderProps(50),
        onChange: notifyUI
    },
    tints: {
        type: OptionType.COMPONENT,
        default: {} as Partial<Record<TintVariable, number>>,
        component: () => <TintSettings />,
        onChange: notifyUI
    },
    clearDatabase: {
        type: OptionType.COMPONENT,
        description: "Delete all stored background media.",
        component: () => (
            <Button
                color={Button.Colors.RED}
                onClick={() => Alerts.show({
                    title: "Delete All Backgrounds",
                    body: "This will permanently delete all stored background media.",
                    confirmColor: Button.Colors.RED,
                    confirmText: "Delete",
                    cancelText: "Cancel",
                    onConfirm: async () => {
                        try {
                            await clear(imageStore);
                        } catch (error) {
                            showFailureToast(`Failed to delete backgrounds: ${getErrorMessage(error)}`);
                            return;
                        }

                        mediaItems.forEach(media => URL.revokeObjectURL(media.src));
                        mediaItems = [];
                        removeBackground();
                        showSuccessToast("All backgrounds deleted");
                    }
                })}
            >
                Delete All Backgrounds
            </Button>
        )
    }
});

function makeAddMediaItem(src: string) {
    return (
        <Menu.MenuItem
            id="vc-bgmanager-add"
            label="Add to Background Manager"
            icon={ImageIcon}
            action={() => fetchAndAddMedia(src)}
        />
    );
}

const imageCtxPatch: NavContextMenuPatchCallback = (children, { src }: ImageContextProps) => {
    if (!src) return;

    const group = findGroupChildrenByChildId("copy-native-link", children) ?? children;
    group.push(makeAddMediaItem(src));
};

const messageCtxPatch: NavContextMenuPatchCallback = (children, props: MessageContextProps) => {
    let src: string | undefined;

    if (props.mediaItem?.contentType?.startsWith("image") || props.mediaItem?.contentType === "video/mp4") {
        src = props.mediaItem.url;
    } else if (props.target?.tagName === "VIDEO") {
        // currentSrc is "" (not nullish) while unset, so ?? would never fall back
        src = props.target.currentSrc || props.target.src;
    } else if (props.target?.dataset?.role === "img") {
        src = props.message?.embeds.find(embed => embed.image?.url === props.target?.href)?.image?.proxyURL;
    }

    if (!src) return;

    const group = findGroupChildrenByChildId("copy-link", children) ?? children;
    group.push(makeAddMediaItem(src));
};

function useMediaItems() {
    const [, update] = useState(0);

    useEffect(() => {
        const listener = () => update(count => count + 1);
        uiListeners.add(listener);
        return () => {
            uiListeners.delete(listener);
        };
    }, []);

    return mediaItems;
}

function useThemeMode() {
    const [themeMode, setThemeMode] = useState<ThemeMode | undefined>(() => getThemeMode());

    useEffect(() => {
        if (!ThemeStore) return;

        const updateThemeMode = () => setThemeMode(getThemeMode());
        ThemeStore.addChangeListener(updateThemeMode);
        updateThemeMode();

        return () => {
            ThemeStore.removeChangeListener(updateThemeMode);
        };
    }, []);

    return themeMode;
}

function AutoPlayVideo(props: ComponentProps<"video">) {
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        videoRef.current?.play().catch(() => { });
    }, [props.src]);

    return <video ref={videoRef} muted loop playsInline {...props} />;
}

function NextIcon() {
    return (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" role="img">
            <path d="M5.7 6.71c-.39.39-.39 1.02 0 1.41L9.58 12 5.7 15.88c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l4.59-4.59c.39-.39.39-1.02 0-1.41L7.12 6.71c-.39-.39-1.03-.39-1.42 0M12.29 6.71c-.39.39-.39 1.02 0 1.41L16.17 12l-3.88 3.88c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l4.59-4.59c.39-.39.39-1.02 0-1.41L13.7 6.7c-.38-.38-1.02-.38-1.41.01" />
        </svg>
    );
}

function BgStyleInjector() {
    const [, update] = useState(0);
    const appSettings = useSettings(["enabledThemes", "enabledThemeLinks", "useQuickCss", "themeActivationModes.*"]);
    const themeMode = useThemeMode();
    const [themeOverrideCss, setThemeOverrideCss] = useState("");

    useEffect(() => {
        const listener = () => update(count => count + 1);
        uiListeners.add(listener);
        return () => {
            uiListeners.delete(listener);
        };
    }, []);

    const { themes: activeThemes, links: activeThemeLinks } = getActiveThemeSources(
        appSettings.enabledThemes,
        appSettings.enabledThemeLinks,
        themeMode
    );
    const activeThemesKey = activeThemes.join("\0");
    const activeThemeLinksKey = activeThemeLinks.join("\0");

    useEffect(() => {
        const media = currentMedia;
        if (!settings.store.overwriteCSS || media?.kind !== "image") {
            setThemeOverrideCss("");
            return;
        }

        let cancelled = false;

        void getThemeCssTargets(
            activeThemes,
            activeThemeLinks,
            appSettings.useQuickCss
        ).then(targets => {
            if (cancelled) return;

            setThemeOverrideCss(targets.map(({ property, selector }) =>
                `${selector}{${property}:url('${media.src}')!important}`
            ).join("\n"));
        }).catch(() => {
            if (!cancelled) setThemeOverrideCss("");
        });

        return () => {
            cancelled = true;
        };
    }, [
        appSettings.useQuickCss,
        currentMedia?.kind,
        currentMedia?.src,
        activeThemeLinksKey,
        activeThemesKey,
        settings.store.overwriteCSS
    ]);

    const hasLayers = currentMedia != null || layerMedia[0] != null || layerMedia[1] != null;
    if (!hasLayers) return null;

    const pluginSettings = settings.store;
    const transition = pluginSettings.enableTransition ? pluginSettings.transitionDuration : 0;
    const filterParts = [
        `grayscale(${pluginSettings.grayscale}%)`,
        `contrast(${pluginSettings.contrast}%)`,
        `saturate(${pluginSettings.saturate}%)`
    ];
    if (pluginSettings.blur > 0) {
        filterParts.push(`blur(${pluginSettings.blur}px)`);
    }

    const filter = filterParts.join(" ");
    const backgroundPosition = `calc(50% - ${pluginSettings.xPosition}%) calc(50% - ${pluginSettings.yPosition}%)`;
    const dimming = pluginSettings.dimming / 100;
    const shouldRenderThemeOverride = currentMedia?.kind === "image" && pluginSettings.overwriteCSS;

    return (
        <>
            {layerMedia.map((media, index) => {
                const isActive = activeLayerIdx === index && currentMedia != null;

                return (
                    <div
                        key={`layer-${index}-${media?.id ?? "empty"}`}
                        className={cl("layer", `layer-${index}`)}
                        style={{
                            opacity: isActive ? 1 : 0,
                            transition: `opacity ${transition}ms ease-out`
                        }}
                    >
                        {media?.kind === "image" && (
                            <div
                                className={cl("layer-image")}
                                style={{
                                    backgroundImage: `url(${media.src})`,
                                    backgroundPosition,
                                    filter
                                }}
                            />
                        )}
                        {media?.kind === "video" && (
                            <AutoPlayVideo
                                key={media.src}
                                className={cl("layer-video")}
                                src={media.src}
                                style={{
                                    filter,
                                    objectPosition: backgroundPosition
                                }}
                            />
                        )}
                        {media && dimming > 0 && (
                            <div
                                className={cl("layer-dim")}
                                style={{ opacity: dimming }}
                            />
                        )}
                    </div>
                );
            })}
            {currentMedia != null && <style>{buildAppTintCss()}</style>}
            {shouldRenderThemeOverride && themeOverrideCss && <style>{themeOverrideCss}</style>}
        </>
    );
}

const SafeBgStyleInjector = ErrorBoundary.wrap(BgStyleInjector, { noop: true });

function MediaThumbnail({ media }: { media: MediaItem; }) {
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState(false);

    return (
        <Clickable
            className={classes(cl("thumb"), media.selected && cl("selected"))}
            aria-label="Set as background"
            onClick={() => {
                selectMedia(media.id);
                // restart the timer so a full interval passes before the next auto-switch
                if (settings.store.enableSlideshow) startSlideshow();
            }}
        >
            {!loaded && !error && <span className={cl("thumb-loading")}>Loading...</span>}
            {error && <span className={cl("thumb-error")}>Error</span>}
            {!error && media.kind === "image" && (
                <img
                    className={loaded ? undefined : cl("hidden")}
                    src={media.src}
                    onLoad={() => setLoaded(true)}
                    onError={() => setError(true)}
                />
            )}
            {!error && media.kind === "video" && (
                <AutoPlayVideo
                    className={loaded ? undefined : cl("hidden")}
                    src={media.src}
                    onLoadedData={() => setLoaded(true)}
                    onError={() => setError(true)}
                />
            )}
            <div className={cl("thumb-info")}>
                <span>{formatSize(media.blob.size)}</span>
                {media.width > 0 && media.height > 0 && <span>{media.width}x{media.height}</span>}
            </div>
            <Tooltip text="Delete Background">
                {tooltipProps => (
                    <button
                        {...tooltipProps}
                        className={cl("delete")}
                        aria-label="Delete Background"
                        onClick={event => {
                            event.stopPropagation();
                            removeMedia(media.id);
                        }}
                    >
                        <DeleteIcon width={16} height={16} />
                    </button>
                )}
            </Tooltip>
        </Clickable>
    );
}

function ManagerPopout() {
    const storedMedia = useMediaItems();
    const { enableSlideshow } = settings.use(["enableSlideshow", "slideshowInterval"]);
    const totalSize = storedMedia.reduce((size, item) => size + item.blob.size, 0);

    const handleFile = useCallback(async (blob: Blob) => {
        try {
            const item = await addMedia(blob);
            if (item) return;

            showFailureToast("Only images and MP4 videos are supported");
        } catch (error) {
            showFailureToast(`Failed to add background media: ${getErrorMessage(error)}`);
        }
    }, []);

    const handleUpload = useCallback(async () => {
        const files = await chooseFile("image/*,video/mp4");
        if (!files) return;

        const selectedFiles = Array.isArray(files) ? files : [files];
        await Promise.all(selectedFiles.map(handleFile));
    }, [handleFile]);

    const slideshowMinutes = getSlideshowIntervalMinutes();
    const intervalLabel = `Every ${slideshowMinutes} minute${slideshowMinutes === 1 ? "" : "s"}`;

    return (
        <Dialog className={cl("popout")}>
            <div className={cl("content")}>
                <div className={cl("title-row")}>
                    <span className={cl("title")}>Background Manager</span>
                    {storedMedia.length > 0 && <span className={cl("summary")}>Total: {formatSize(totalSize)}</span>}
                </div>
                <div className={cl("input-row")}>
                    <div className={cl("slideshow-control")}>
                        <div className={cl("slideshow-meta")}>
                            <span className={cl("slideshow-label")}>Slideshow</span>
                            <span className={cl("slideshow-note")}>{intervalLabel}</span>
                        </div>
                        <Switch checked={enableSlideshow} onChange={enabled => { settings.store.enableSlideshow = enabled; }} />
                    </div>
                    <Tooltip text="Upload Backgrounds">
                        {tooltipProps => (
                            <button {...tooltipProps} className={cl("btn", "btn-upload")} aria-label="Upload Backgrounds" onClick={handleUpload}>
                                <CloudUploadIcon />
                            </button>
                        )}
                    </Tooltip>
                    <Tooltip text="Remove Background">
                        {tooltipProps => (
                            <button {...tooltipProps} className={cl("btn", "btn-remove")} aria-label="Remove Background" onClick={deselectAll}>
                                <NoEntrySignIcon />
                            </button>
                        )}
                    </Tooltip>
                </div>
                {enableSlideshow && storedMedia.length >= 2 && (
                    <div className={cl("info")}>
                        <span>{intervalLabel}</span>
                        <Tooltip text="Next Background">
                            {tooltipProps => (
                                <button {...tooltipProps} className={cl("btn", "btn-next")} aria-label="Next Background" onClick={nextImage}>
                                    <NextIcon />
                                </button>
                            )}
                        </Tooltip>
                    </div>
                )}
                <div className={cl("grid")}>
                    {storedMedia.map(media => <MediaThumbnail key={media.id} media={media} />)}
                </div>
            </div>
        </Dialog>
    );
}

function BgManagerHeaderButton() {
    const buttonRef = useRef<HTMLDivElement>(null);
    const [isOpen, setIsOpen] = useState(false);

    return (
        <Popout
            position="bottom"
            align="right"
            spacing={8}
            animation={Popout.Animation.NONE}
            shouldShow={isOpen}
            onRequestClose={() => setIsOpen(false)}
            targetElementRef={buttonRef}
            renderPopout={() => <ErrorBoundary><ManagerPopout /></ErrorBoundary>}
        >
            {(_, { isShown }) => (
                <HeaderBarButton
                    ref={buttonRef}
                    icon={ImageIcon}
                    tooltip={isShown ? null : "Background Manager"}
                    onClick={() => setIsOpen(open => !open)}
                    selected={isShown}
                />
            )}
        </Popout>
    );
}

export default definePlugin({
    name: "BackgroundManager",
    description: "Manage custom background images and MP4 videos with slideshow, transitions, and adjustments. Originally by Narukami.",
    authors: [EquicordDevs.benjii],
    settings,

    patches: [
        {
            find: "this.renderArtisanalHack()",
            replacement: {
                match: /children:(\i)=>\(0,(\i)\.jsx\)\("div",\{className:(\i)\(\)\((\i)\.bg,\1\)\}\)/,
                replace: 'children:$1=>(0,$2.jsx)("div",{className:$3()($4.bg,$1,$self.getHostClass()),children:$self.renderBgStyles()})'
            }
        }
    ],

    contextMenus: {
        "image-context": imageCtxPatch,
        message: messageCtxPatch,
    },

    headerBarButton: {
        icon: ImageIcon,
        render: BgManagerHeaderButton,
    },

    getHostClass() {
        return cl("host");
    },

    renderBgStyles() {
        return <SafeBgStyleInjector />;
    },

    async start() {
        const generation = ++startGeneration;
        const [loadedItems, activeId] = await Promise.all([
            loadFromDB(),
            get<number>(ACTIVE_ID_KEY, imageStore).catch(() => undefined)
        ]);

        if (generation !== startGeneration) {
            loadedItems.forEach(item => URL.revokeObjectURL(item.src));
            return;
        }

        mediaItems = loadedItems;
        themeCssTargetCache.clear();

        if (settings.store.overwriteCSS) {
            const { themes, links } = getActiveThemeSources(
                AppSettings.enabledThemes,
                AppSettings.enabledThemeLinks,
                getThemeMode()
            );
            void getThemeCssTargets(themes, links, AppSettings.useQuickCss).then(() => {
                if (generation !== startGeneration) themeCssTargetCache.clear();
            }).catch(error => logger.error("Failed to preload theme CSS targets", error));
        }

        const selectedMedia = mediaItems.find(item => item.id === activeId);
        if (selectedMedia) {
            selectedMedia.selected = true;
            setBackground(selectedMedia);
        }
        if (settings.store.enableSlideshow) startSlideshow();
    },

    stop() {
        startGeneration++;
        stopSlideshow();
        removeBackground();
        themeCssTargetCache.clear();
        mediaItems.forEach(media => URL.revokeObjectURL(media.src));
        mediaItems = [];
    }
});
