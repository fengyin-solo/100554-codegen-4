import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { syncDeviationTodos } from '@/api/ncr-service'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)

// 首次进入就把不合格品处置结论反映到偏差处理待办，两处始终同一套。
syncDeviationTodos()

app.mount('#app')
