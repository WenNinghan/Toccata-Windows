// Windows 104-key physical layout. Shared historical keys retain upstream IDs;
// Windows-only key IDs are versioned in data/keyboard.js. Pause is displayed
// but marked unavailable until its E1 multi-byte sequence is validated.
window.TOCCATA_LAYOUT = {
 id:'windows-full-104', name:'Windows 104-key', unit:54, keyGap:6, rowStep:1,
 rows:[
  [
   {code:53,label:'Esc'}, {code:122,label:'F1',x:1}, {code:120,label:'F2'}, {code:99,label:'F3'}, {code:118,label:'F4'},
   {code:96,label:'F5',x:.5}, {code:97,label:'F6'}, {code:98,label:'F7'}, {code:100,label:'F8'},
   {code:101,label:'F9',x:.5}, {code:109,label:'F10'}, {code:103,label:'F11'}, {code:111,label:'F12'},
   {code:1311,label:'PrtSc',x:.5}, {code:1070,label:'Scroll'}, {code:1581,label:'Pause',unavailable:true}
  ],
  [
   {code:50,label:'`'}, {code:18,label:'1'}, {code:19,label:'2'}, {code:20,label:'3'}, {code:21,label:'4'}, {code:23,label:'5'},
   {code:22,label:'6'}, {code:26,label:'7'}, {code:28,label:'8'}, {code:25,label:'9'}, {code:29,label:'0'}, {code:27,label:'-'}, {code:24,label:'='}, {code:51,label:'Backspace',w:2},
   {code:1338,label:'Insert',x:.5}, {code:1327,label:'Home'}, {code:1329,label:'PgUp'},
   {code:1069,label:'Num',x:.5}, {code:1309,label:'/'}, {code:1055,label:'*'}, {code:1074,label:'−'}
  ],
  [
   {code:48,label:'Tab',w:1.5}, {code:12,label:'Q'}, {code:13,label:'W'}, {code:14,label:'E'}, {code:15,label:'R'}, {code:17,label:'T'},
   {code:16,label:'Y'}, {code:32,label:'U'}, {code:34,label:'I'}, {code:31,label:'O'}, {code:35,label:'P'}, {code:33,label:'['}, {code:30,label:']'}, {code:42,label:'\\',w:1.5},
   {code:1339,label:'Delete',x:.5}, {code:1335,label:'End'}, {code:1337,label:'PgDn'},
   {code:1071,label:'7',x:.5}, {code:1072,label:'8'}, {code:1073,label:'9'}, {code:1078,label:'+',h:2}
  ],
  [
   {code:57,label:'Caps Lock',w:1.75}, {code:0,label:'A'}, {code:1,label:'S'}, {code:2,label:'D'}, {code:3,label:'F'}, {code:5,label:'G'},
   {code:4,label:'H'}, {code:38,label:'J'}, {code:40,label:'K'}, {code:37,label:'L'}, {code:41,label:';'}, {code:39,label:"'"}, {code:36,label:'Enter',w:2.25},
   {code:1075,label:'4',x:4}, {code:1076,label:'5'}, {code:1077,label:'6'}
  ],
  [
   {code:56,label:'Shift',w:2.25}, {code:6,label:'Z'}, {code:7,label:'X'}, {code:8,label:'C'}, {code:9,label:'V'}, {code:11,label:'B'},
   {code:45,label:'N'}, {code:46,label:'M'}, {code:43,label:','}, {code:47,label:'.'}, {code:44,label:'/'}, {code:60,label:'Shift',w:2.75},
   {code:126,label:'↑',x:1.5}, {code:1079,label:'1',x:1.5}, {code:1080,label:'2'}, {code:1081,label:'3'}, {code:1284,label:'Enter',h:2}
  ],
  [
   {code:59,label:'Ctrl',w:1.25}, {code:55,label:'Win',w:1.25}, {code:58,label:'Alt',w:1.25}, {code:49,label:'Space',w:6.25},
   {code:61,label:'Alt',w:1.25}, {code:54,label:'Win',w:1.25}, {code:1349,label:'Menu',w:1.25}, {code:62,label:'Ctrl',w:1.25},
   {code:123,label:'←',x:.5}, {code:125,label:'↓'}, {code:124,label:'→'},
   {code:1082,label:'0',w:2,x:.5}, {code:1083,label:'.'}
  ]
 ]
};
