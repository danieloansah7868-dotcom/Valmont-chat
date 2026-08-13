'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('native Android shell is a real application project, not a PWA shortcut', () => {
  const manifest = fs.readFileSync(path.join(root, 'native/android/app/src/main/AndroidManifest.xml'), 'utf8');
  const activity = fs.readFileSync(path.join(root, 'native/android/app/src/main/java/app/vchat/nativeapp/MainActivity.java'), 'utf8');
  const gradle = fs.readFileSync(path.join(root, 'native/android/app/build.gradle'), 'utf8');
  assert.match(manifest, /android:name="\.MainActivity"/);
  assert.match(gradle, /namespace "app\.vchat\.nativeapp"/);
  assert.match(manifest, /android.permission.CAMERA/);
  assert.match(manifest, /android.permission.RECORD_AUDIO/);
  assert.match(activity, /VChatNative\/1\.0 Android/);
  assert.match(activity, /setJavaScriptEnabled\(true\)/);
  assert.match(activity, /onShowFileChooser/);
  assert.match(activity, /RESOURCE_VIDEO_CAPTURE/);
  assert.match(gradle, /applicationId "app\.vchat\.nativeapp"/);
  assert.ok(fs.existsSync(path.join(root, 'native/android/app/src/main/res/mipmap-hdpi/ic_launcher.png')));
});

test('desktop and iOS shells identify as native VChat', () => {
  const desktop = fs.readFileSync(path.join(root, 'native/desktop/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'native/desktop/preload.js'), 'utf8');
  const ios = fs.readFileSync(path.join(root, 'native/ios/ViewController.swift'), 'utf8');
  const guide = fs.readFileSync(path.join(root, 'public/native-app.html'), 'utf8');
  assert.match(desktop, /VChatNative\/1\.0 Desktop/);
  assert.match(preload, /vchatNative/);
  assert.match(ios, /VChatNative\/1\.0 iOS/);
  assert.match(guide, /Turn VChat into a real app/);
  assert.match(guide, /Cloud is navy/);
  assert.match(guide, /SMS is orange/);
});
