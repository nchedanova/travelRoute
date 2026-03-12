// ── ROUTE DATA ────────────────────────────────────────────────────────────────
// Базовые данные маршрута. Перезаписываются при загрузке из облака/localStorage.
const DAYS_DATA = {
  1: {
    color:'#f5a623',
    date:'24 апреля',
    departP:'03:00', departA:'',
    start:{ lat:55.796967, lng:37.947488, name:'Балашиха', icon:'🏠' },
    stops:[
      { id:'d1s1', num:1, icon:'⛽', type:'Заправка', name:'Газпромнефть у Ефремова',
        lat:53.700104, lng:38.045031, arrP:'05:50', depP:'06:00', arrA:'', depA:'' },
      { id:'d1s2', num:2, icon:'🥞', type:'Кафе', name:'Помпончик · Ефремов',
        lat:53.204038, lng:38.225938, arrP:'06:40', depP:'07:30', arrA:'', depA:'' },
      { id:'d1s3', num:3, icon:'⛽', type:'Заправка', name:'Газпромнефть за Воронежем',
        lat:51.247589, lng:39.654248, arrP:'10:30', depP:'10:40', arrA:'', depA:'' },
      { id:'d1s4', num:4, icon:'🍜', type:'Кафе', name:'Помпончик · у Павловска',
        lat:50.597873, lng:40.152914, arrP:'11:30', depP:'12:30', arrA:'', depA:'' },
      { id:'d1s5', num:5, icon:'⛽', type:'Заправка', name:'Газпромнефть за Богучаром',
        lat:49.602400, lng:40.549723, arrP:'13:40', depP:'14:00', arrA:'', depA:'' },
      { id:'d1s6', num:6, icon:'⛽', type:'Заправка', name:'Газпромнефть Ростов-на-Дону',
        lat:47.278214, lng:39.796337, arrP:'17:30', depP:'', arrA:'', depA:'' },
      { id:'d1s7', num:7, icon:'🛎', type:'Отель', name:'Амакс Конгресс Отель',
        lat:47.248822, lng:39.711902, arrP:'18:00', depP:'', arrA:'', depA:'' },
    ]
  },
  2: {
    color:'#60a5fa',
    date:'25 апреля',
    departP:'09:00', departA:'',
    start:{ lat:47.248822, lng:39.711902, name:'Амакс Конгресс Отель', icon:'🛎' },
    stops:[
      { id:'d2s1', num:1, icon:'⛽', type:'Заправка', name:'Газпромнефть',
        lat:46.079930, lng:39.781240, arrP:'10:40', depP:'11:00', arrA:'', depA:'' },
      { id:'d2s2', num:2, icon:'🥗', type:'Кафе', name:'Сицилия · Кореновск',
        lat:45.463089, lng:39.449137, arrP:'12:00', depP:'13:00', arrA:'', depA:'' },
      { id:'d2s3', num:3, icon:'🏠', type:'Жильё', name:'ЖК Синее Море',
        lat:44.707314, lng:37.782650, arrP:'16:30', depP:'', arrA:'', depA:'' },
    ]
  }
};

// ── STATE ─────────────────────────────────────────────────────────────────────
let state = { actuals: {} };

function dayKeys() {
  return Object.keys(DAYS_DATA).map(Number);
}
