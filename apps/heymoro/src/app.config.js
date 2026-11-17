export default {
  pages: ['pages/index/index', 'pages/effects/index', 'pages/me/index', 'pages/create/index', 'pages/cabinet/index', 'pages/artifact/index', 'pages/sessions/index', 'pages/example/index', 'pages/credits/index', 'pages/credit-reservations/index'],
  window: { navigationStyle: 'custom', backgroundTextStyle: 'dark', backgroundColor: '#F4F6FA', navigationBarTitleText: 'Heymoro', navigationBarTextStyle: 'black' },
  tabBar: {
    color: '#556478',
    selectedColor: '#284E9A',
    backgroundColor: '#FFFFFF',
    borderStyle: 'white',
    list: [
      { pagePath: 'pages/index/index', text: '首页', iconPath: 'assets/home.png', selectedIconPath: 'assets/home-selected.png' },
      { pagePath: 'pages/effects/index', text: '特效', iconPath: 'assets/effects.png', selectedIconPath: 'assets/effects-selected.png' },
      { pagePath: 'pages/me/index', text: '我的', iconPath: 'assets/me.png', selectedIconPath: 'assets/me-selected.png' },
    ],
  },
  lazyCodeLoading: 'requiredComponents',
}
