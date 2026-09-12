import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus, { ElMessage } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import VueKonva from 'vue-konva';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import './style.css';
import App from './App.vue';
const app = createApp(App)
  .use(createPinia())
  .use(ElementPlus, { locale: zhCn, size: 'small' })
  .use(VueKonva);
app.config.errorHandler = (error) =>
  ElMessage.error(error instanceof Error ? error.message : String(error));
app.mount('#app');
