'use strict';

const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('vchatNative', true);
