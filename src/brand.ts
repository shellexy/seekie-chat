// 欢迎页用的是线稿版（build/welcome-icon.png）：白底已转成透明，只留黑色线条。
// 这张图不能直接当图片用——浅色主题下黑线配白底没问题，深色主题下近黑的线配近黑的底
// 会整个消失。改用 CSS mask：形状由 PNG 的 alpha 决定，颜色交给主题的 --text，
// 一份素材在两种主题下都正确，也不需要 invert 滤镜或第二张图。
// 程序/任务栏图标另用 build/icon.png 的彩色版，小尺寸下才认得出。
import welcomeIconUrl from '../build/welcome-icon.png';
export const welcomeMask = `url(${welcomeIconUrl})`;
