// 一次公告的界面组件，读打包图片后组合标题/文章地址/可选图像与边框；只显示链接，不主动打开或下载网页。
// fs命名空间提供同步读取；仅第一次loadImageBase64调用才尝试读包内固定资源。
import * as fs from "node:fs";
// Container按孩子排列，Text文字、Spacer空行、Image负责终端图像协议/回退；构造不等实际绘屏。
import { Container, Image, Spacer, Text } from "@earendil-works/pi-tui";
// 打包资产统一经config适配源码/npm/独立二进制路径，避免直接依赖__dirname。
import { getBundledInteractiveAssetPath } from "../../../config.ts";
// 全局theme代理需先初始化；直接文字在构造时上色，边框回调则稍后读当前主题。
import { theme } from "../theme/theme.ts";
// 动态边框按实际渲染宽生成横线，不在此写死列宽。
import { DynamicBorder } from "./dynamic-border.ts";

// 文章URL是展示文字常量，不在模块求值时联网。
const BLOG_URL = "https://mariozechner.at/posts/2026-04-08-ive-sold-out/";
// 固定PNG资源名，经config帮助函数定位。
const IMAGE_FILENAME = "clankolas.png";

// 成功后缓存Base64文字，可undefined；没有存Image实例。
let cachedImageBase64: string | undefined;
// 独立标志记录已经尝试，读失败也不再自动重试。
let attemptedImageLoad = false;

// 同步读取并缓存一次内置图片Base64，返回string或undefined，无参数；例第二个公告复用第一次读到的文字。
// 先标记尝试再读路径/文件，失败吞错并缓存缺失，整个进程模块实例内不提供刷新；不验证读到的是有效PNG。
function loadImageBase64(): string | undefined {
	// 之前尝试过就直接读缓存，区分失败undefined与从未尝试。
	if (attemptedImageLoad) {
		// 返回原字符串或undefined，不重复IO。
		return cachedImageBase64;
	}

	// 先置true，下面解析路径或读文件失败也记为已尝试。
	attemptedImageLoad = true;
	// 路径解析/同步读取/转Base64都在try中。
	try {
		// 读取包内资产为Buffer再编码，不读取用户指定路径或下载URL。
		cachedImageBase64 = fs.readFileSync(getBundledInteractiveAssetPath(IMAGE_FILENAME)).toString("base64");
		// 本地资源不可用时降级不显示图像。
	} catch {
		// 缓存undefined，不向构造器抛原文件错误。
		cachedImageBase64 = undefined;
	}
	// 返回成功文字或失败缺失值。
	return cachedImageBase64;
}

// 公告容器继承布局与render；上游添加进聊天区后才真正参与展示，不创建独立终端。
export class EarendilAnnouncementComponent extends Container {
	// 无参数构造公告：上下边框→标题/地址→可选固定PNG；会首次同步读资源、分配组件，无网络/打开链接。
	// 例new EarendilAnnouncementComponent()供主界面插入；主题未初始化可抛，读图失败仅省图，不等所有构造错误都吞。
	constructor() {
		// 先初始化Container父类，才能访问this。
		super();

		// 顶部边框传箭头回调，渲染时才以accent上色。
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		// 标题立即先accent再bold，Text左右padding1、垂直0。
		this.addChild(new Text(theme.bold(theme.fg("accent", "pi has joined Earendil")), 1, 0));
		// 标题后留一个空行。
		this.addChild(new Spacer(1));
		// 提示文案立即muted，非URL跳转动作。
		this.addChild(new Text(theme.fg("muted", "Read the blog post:"), 1, 0));
		// 文章地址用mdLink色显示；仅着色不保证OSC8点击链接。
		this.addChild(new Text(theme.fg("mdLink", BLOG_URL), 1, 0));
		// 链接后空一行。
		this.addChild(new Spacer(1));

		// 尝试一次性获取内置图片文本，失败undefined。
		const imageBase64 = loadImageBase64();
		// 只有真值Base64才添加图；空文件编码为空串也会省略。
		if (imageBase64) {
			// 将图片组件作为孩子，不在这里直接输出协议。
			this.addChild(
				// 创建Image时会尝试从图片头读像素尺寸；协议能力选择/布局/必要转码在后续显示流程中进行。
				new Image(
					// Base64是已读取数据，不是路径。
					imageBase64,
					// 声明PNG MIME，不在本函数验证格式。
					"image/png",
					// 不能显示图片时文字回退用muted，回调延迟读取主题。
					{ fallbackColor: (text) => theme.fg("muted", text) },
					// 最大56列并给占位文件名；不是固定像素宽，也不保证一定占56列。
					{ maxWidthCells: 56, filename: IMAGE_FILENAME },
				),
			);
			// 有图片时才再留一个空行。
			this.addChild(new Spacer(1));
		}

		// 底边框同样按渲染宽/当前accent计算。
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
	}
}
