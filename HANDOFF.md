# Page Generator — Handoff

Цей документ описує поточний стан проєкту, прийняту архітектуру та напрям наступної розробки. Він призначений одночасно для власника проєкту й наступного агента/розробника.

## 1. Мета проєкту

Page Generator має перетворювати:

- screenshot;
- кілька screenshot;
- Figma frame;
- у майбутньому відеокадри;

на редаговану структуру сторінки.

Головна вимога: генератор не повинен бути прив'язаний до конкретної мови, тексту або одного конструктора. Він має визначати компоненти переважно за геометрією, CV-ознаками, кольорами, повторенням і просторовими зв'язками, а OCR повинен постачати текст, координати й confidence.

Кінцевий результат має бути не одним великим HTML widget, а структурованим деревом компонентів, яке можна:

1. редагувати у власному editor/canvas;
2. відрендерити у власному runtime;
3. експортувати в Elementor;
4. експортувати в Gutenberg;
5. експортувати у статичний HTML;
6. порівняти з reference screenshot.

## 2. Поточні файли

Основний плагін:

- `page-generator.php` — bootstrap плагіна, AJAX, Figma import, schema validation, serializers, Gutenberg output, Elementor output, HTML fallback.
- `assets/editor.js` — UI, OCR/OpenCV pipeline, screenshot analysis, semantic schema, Elementor frontend insertion, schema preview.
- `assets/editor.css` — modal/editor styles, Gutenberg toolbar button styles, preview styles.
- `assets/admin.js` — settings page behavior.
- `assets/admin.css` — settings page styles.
- `tools/screenshot-runner.js` — Playwright screenshot comparison.
- `tools/package.json` — Node dependencies.
- `tools/package-lock.json` — locked dependency versions.
- `.gitignore` — ігнорує `tools/node_modules/`.

Старий плагін:

- `../site-generator/site-generator.php` — legacy plugin. Він не є основою нової архітектури й не повинен використовуватися для нового renderer.

## 3. Поточна pipeline

Поточний задум pipeline:

```text
Raw screenshot analysis
→ Raw detections
→ Spatial ownership
→ Semantic Page Schema
→ Schema validation
→ Native/own renderer
→ Elementor serializer
→ Gutenberg serializer
→ Local HTML fallback
→ Screenshot comparison
```

### Raw screenshot analysis

Зображення завантажується на canvas. Tesseract.js виконує OCR, OpenCV.js шукає контури та області, а pixel analysis визначає палітру, variance, секційні bands і приблизні фони.

### Raw detections

Детекції можуть містити:

- OCR words/lines;
- bbox;
- contours;
- repeated regions;
- rounded corners;
- variance;
- gradient;
- sampled background;
- crop asset;
- color tokens.

### Spatial ownership

Кожен текст і кожен visual region мають бути прив'язані лише до одного логічного батька. Це необхідно, щоб текст із таблиці не потрапляв у форму, а область одного card не ставала частиною сусіднього card.

### Semantic Page Schema

Schema є внутрішнім джерелом правди. Типова структура вузла:

```json
{
  "id": "node-id",
  "type": "card",
  "role": "content-card",
  "text": "",
  "content": "",
  "bbox": {
    "x": 0,
    "y": 0,
    "width": 320,
    "height": 180
  },
  "settings": {},
  "style": {
    "background": "#ffffff",
    "color": "#202020",
    "borderRadius": 8
  },
  "children": [],
  "behavior": {
    "type": "none"
  },
  "confidence": 0.7,
  "detection": {
    "detectedBy": ["opencv", "ocr"],
    "manual": false
  }
}
```

## 4. Що вже реалізовано

- Окремий `page-generator` plugin.
- Figma URL/token flow.
- Screenshot upload.
- Tesseract.js OCR.
- OpenCV.js region detection.
- Dominant colors і section bands.
- Crop assets upload у WordPress Media Library.
- Recursive semantic tree.
- Confidence/confidenceParts.
- Form/table heuristics.
- Color normalization.
- Schema validation базового рівня.
- Native Elementor tree serializer через `_elementor_data`.
- Frontend Elementor insertion через `$e.run('document/elements/create', ...)`.
- Gutenberg toolbar button.
- Gutenberg output для стандартних core blocks.
- HTML fallback лише для складних вузлів.
- Playwright screenshot comparison.
- Visual, perceptual, text і DOM metrics.
- `.gitignore` для `tools/node_modules/`.
- Portable Node runner без обов'язкових Windows-шляхів у самому плагіні.

## 5. Поточні проблеми

### 5.1. Візуальна класифікація ще нестабільна

OCR уже знаходить значний обсяг тексту, але кнопки, картки, таблиці та image regions можуть втрачатися через надто суворі умови grouping/region filtering.

Не можна вирішувати це словником:

```text
"замовити" → button
"контакти" → link
"email" → form
```

Це знищує абстракцію й прив'язує систему до мови.

Правильний підхід:

- button визначається за bbox навколо тексту, fill, border, radius, contrast, alignment;
- card визначається за surface region, повторенням, padding і групуванням;
- image визначається за texture/variance, aspect ratio, crop та asset binding;
- table визначається за rows/columns/alignment/borders;
- form визначається за повторюваними полями, alignment і input-like rectangles;
- OCR використовується як content, а не як головний semantic classifier.

### 5.2. Кольори

`tokens.colors` — це лише глобальна палітра. Вона не гарантує, що конкретний node отримав правильний `style.background` або `style.color`.

Потрібно зберігати окремо:

```json
{
  "tokens": {
    "colors": []
  },
  "semanticColors": {
    "pageBackground": "#ffffff",
    "text": "#202020",
    "mutedText": "#606080",
    "primary": "#208040",
    "border": "#e0e0e0"
  }
}
```

І обов'язково призначати кольори вузлам:

```json
{
  "style": {
    "background": "#208040",
    "color": "#ffffff"
  }
}
```

### 5.3. Coordinate spaces

У schema ще потрібно чітко розділити:

- page bbox;
- local bbox;
- parent id;
- coordinate space;
- responsive constraints.

Не можна неявно складати offsets різних рівнів. Це вже спричиняло негативні `top`, гігантські форми та неправильне вкладення.

### 5.4. Gutenberg

У Gutenberg немає універсального стандартного Card block. Тому картки допустимо робити локальним HTML fallback або власним custom block.

Рекомендована стратегія:

```text
heading/text/button/image → native core blocks
card/table/form/complex component → local HTML або custom page-generator block
```

Не потрібно змушувати картку ставати `core/group`, якщо це погіршує візуальний результат. Важливо, щоб HTML був локальним для конкретної картки, а не всієї сторінки.

### 5.5. Elementor

Elementor уже дає кращу структурованість для частини компонентів:

- native containers;
- heading;
- text;
- image;
- button;
- badge/container;
- local HTML fallback для form/table.

Потрібно продовжити перевірку справжнього `_elementor_data` і Navigator на різних версіях Elementor.

### 5.6. Asset binding

Image node має створюватися як справжній image лише коли існує:

```text
asset.url
asset.id або attachmentId
```

Якщо crop не завантажився, потрібно явно позначати node як `unresolved-image`, а не мовчки створювати звичайний порожній placeholder.

## 6. Двошарова розробка — рекомендований напрям

Це основна архітектурна рекомендація.

### Шар 1: власна пісочниця

Генератор працює у власному editor/canvas і не підлаштовується під обмеження Elementor або Gutenberg.

```text
Screenshot/Figma/video
→ analysis
→ Page Schema
→ own canvas
→ tree editor
→ properties panel
→ responsive preview
→ validation
```

Власний editor має контролювати:

- повну ширину;
- viewport;
- flex/grid;
- absolute positioning у pixel-match mode;
- нормальний flow у responsive mode;
- cards;
- forms;
- tables;
- navigation;
- z-index;
- typography;
- colors;
- breakpoints;
- interactions;
- assets;
- manual corrections.

### Шар 2: adapters/exporters

Одна Page Schema експортується у різні target formats:

```text
Page Schema
├── Own Runtime renderer
├── Elementor serializer
├── Gutenberg serializer
└── Static HTML/CSS/JS exporter
```

Elementor і Gutenberg не повинні бути внутрішнім форматом. Вони є лише export targets.

### Чому це не повернення до старого HTML підходу

Поганий підхід:

```text
Screenshot
→ HTML string
→ один HTML widget
```

Правильний підхід:

```text
Screenshot
→ Page Schema
→ own editor tree
→ renderer
→ DOM/HTML як результат
```

У другому варіанті джерелом правди є schema, а HTML лише генерується renderer-ом. Кожен node можна перемістити, змінити, видалити, повторно експортувати в інший target.

## 7. Внутрішня структура, яку варто будувати

Поступова структура проєкту:

```text
page-generator/
├── page-generator.php
├── assets/
│   ├── editor.js
│   ├── editor.css
│   ├── admin.js
│   └── admin.css
├── core/
│   ├── schema/
│   │   ├── schema-types.js
│   │   ├── schema-normalizer.js
│   │   └── schema-validator.js
│   ├── spatial/
│   │   ├── ownership.js
│   │   ├── coordinate-spaces.js
│   │   └── grouping.js
│   ├── components/
│   │   ├── registry.js
│   │   ├── confidence.js
│   │   └── component-inference.js
│   └── assets/
│       ├── crop-manager.js
│       └── asset-binding.js
├── analysis/
│   ├── ocr.js
│   ├── opencv.js
│   ├── colors.js
│   ├── sections.js
│   └── detections.js
├── editor/
│   ├── app.js
│   ├── canvas.js
│   ├── tree.js
│   ├── inspector.js
│   ├── toolbar.js
│   └── breakpoints.js
├── renderers/
│   ├── dom-renderer.js
│   ├── static-html-renderer.js
│   ├── elementor-serializer.php
│   ├── gutenberg-serializer.php
│   └── component-renderer.php
├── comparison/
│   └── screenshot-runner.js
├── tools/
│   ├── package.json
│   ├── package-lock.json
│   └── .gitignore
└── HANDOFF.md
```

Це цільова структура. Не потрібно переносити все одним великим рефакторингом. Спочатку треба винести core/schema та component registry, потім editor/canvas.

## 8. Component Registry

Component Registry — це єдиний опис того, що таке компонент і як його підтримують різні renderer-и.

Приклад концепції:

```javascript
const componentRegistry = {
    card: {
        roles: ['surface', 'content-card'],
        canContain: ['heading', 'text', 'image', 'button'],
        infer: inferCard,
        renderDom: renderCard,
        serializeElementor: serializeCardToElementor,
        serializeGutenberg: serializeCardToGutenberg,
        renderStaticHtml: renderCardToHtml,
        validate: validateCard
    },
    button: {
        roles: ['primary-action', 'secondary-action'],
        canContain: [],
        infer: inferButtonFromGeometry,
        renderDom: renderButton,
        serializeElementor: serializeButtonToElementor,
        serializeGutenberg: serializeButtonToGutenberg,
        renderStaticHtml: renderButtonToHtml,
        validate: validateButton
    }
};
```

### Що має бути у registry

Для кожного component type:

- допустимі roles;
- допустимі children;
- inference function;
- schema defaults;
- validator;
- DOM renderer;
- Elementor serializer;
- Gutenberg serializer;
- static HTML renderer;
- editor inspector fields;
- responsive behavior;
- fallback policy;
- confidence policy.

### Що це дасть

Без registry логіка розповзається по умовах:

```javascript
if (node.type === 'button') ...
if (node.type === 'card') ...
if (node.type === 'image') ...
```

У результаті frontend, PHP, Elementor і Gutenberg починають поводитися по-різному.

З registry:

```text
один компонент
→ одна schema definition
→ один validator
→ власний renderer
→ Elementor adapter
→ Gutenberg adapter
→ HTML fallback adapter
```

Це дозволить:

- додавати нові компоненти без переписування pipeline;
- мати локальний fallback лише там, де він потрібен;
- підтримувати cards навіть без native Gutenberg Card block;
- однаково показувати компонент у власному editor і після export;
- контролювати confidence;
- робити schema migrations;
- тестувати кожен тип незалежно.

## 9. Власний editor

Першу версію власного editor краще робити не як повний аналог Elementor, а як контрольовану пісочницю:

```text
left: component tree
center: canvas
right: inspector
top: viewport/mode/actions
```

### Мінімальні функції

- показ Page Schema на canvas;
- вибір node;
- drag/move;
- resize;
- зміна type;
- зміна text;
- зміна colors;
- зміна background;
- зміна padding/gap;
- додавання card/button/text/image;
- видалення node;
- undo/redo;
- збереження schema у post meta;
- preview;
- export;
- screenshot comparison.

### Режими layout

```text
Responsive mode:
  flex/grid/normal flow
  width: 100%
  max-width
  breakpoints

Pixel-match mode:
  координати screenshot
  absolute positioning дозволена
  фіксований reference viewport
```

Не слід переносити абсолютні координати з screenshot у responsive layout без нормалізації.

## 10. RobotJS: де використовувати, а де ні

RobotJS не варто робити основою генератора. Він залежить від:

- координат екрана;
- zoom;
- viewport;
- scroll;
- теми;
- розташування панелей;
- ОС;
- стану UI.

Основний порядок має бути:

```text
schema → direct serializer/API
```

Для перевірки використовувати Playwright:

```text
open editor
inspect DOM
check Navigator
save
open preview
compare screenshot
```

RobotJS можна залишити лише як крайній compatibility/test fallback для UI, де немає API або DOM-доступу.

## 11. Gutenberg policy

Gutenberg не повинен бути внутрішнім обмеженням.

Рекомендована політика:

```text
heading → core/heading
text → core/paragraph
button → core/button
image → core/image
card → local HTML або власний page-generator block
table → local HTML або власний block
form → local HTML або власний block
section/grid → core/group або власний block
```

Картка в Gutenberg може бути локальним HTML без повернення до whole-page HTML. Це прийнятний компроміс, якщо HTML містить лише один компонент і схема залишається джерелом правди.

## 12. Elementor policy

Elementor використовується як export target:

```text
container/section → container
heading → heading widget
text → text-editor
button → button widget
image → image widget
card/grid → nested containers
form/table/unsupported → local HTML widget
```

Не слід повертати модель:

```text
page → one HTML widget
```

Потрібно мати окремий тест, який перевіряє:

- кількість top-level containers;
- кількість native widgets;
- наявність HTML widget тільки в дозволених node types;
- відсутність whole-page HTML widget;
- коректність `_elementor_data`.

## 13. Переїзд на Arch Linux

У самій папці плагіна критичних Windows-specific шляхів немає. Не потрібно переносити `wp-config.php`, бо це файл конкретної WordPress інсталяції.

Переносити:

- source files;
- `assets/`;
- `tools/package.json`;
- `tools/package-lock.json`;
- `tools/screenshot-runner.js`.

Не переносити:

```text
tools/node_modules/
```

На Arch виконати:

```bash
cd wp-content/plugins/page-generator/tools
npm ci
npx playwright install chromium
```

Після цього перевірити:

- Node доступний для PHP-FPM/Apache;
- `shell_exec` не вимкнений;
- PHP має права на temp/uploads;
- Chromium запускається з користувача PHP;
- WordPress REST/AJAX працює;
- CDN для OCR/OpenCV доступний або бібліотеки локалізовані.

## 14. Наступний крок

### Мета наступного кроку

Не додавати нові словникові евристики. Спочатку зробити мінімальний власний Component Registry і діагностичний schema output.

### Конкретні задачі

1. Винести список типів компонентів у registry:
   - page;
   - section;
   - container;
   - heading;
   - text;
   - button;
   - image;
   - card;
   - grid;
   - gallery;
   - form;
   - form-field;
   - table;
   - navigation;
   - badge.

2. Додати для кожного type:
   - default schema;
   - allowed children;
   - validator;
   - detection source;
   - fallback policy.

3. Зробити окрему діагностику після аналізу:

```text
sections
text nodes
button nodes
card nodes
image nodes
gallery nodes
table nodes
form nodes
unclaimed OCR nodes
unclaimed CV regions
regions without asset
nodes without color
```

4. Перевірити на одному й тому самому screenshot:
   - скільки CV regions знайдено;
   - скільки regions були відкинуті;
   - скільки nodes потрапило у schema;
   - скільки native nodes потрапило у Elementor/Gutenberg;
   - скільки HTML fallbacks створено.

5. Додати fixture test для schema:

```text
одна section
одна card
один button
одне image
одна form
одна table
```

6. Перевірити кожен exporter на цьому fixture без OCR/OpenCV.

7. Лише після цього починати власний canvas/editor.

### Критерій завершення наступного кроку

Наступний крок вважається завершеним, якщо:

- один fixture schema однаково рендериться у власному DOM;
- Elementor serializer створює native tree;
- Gutenberg serializer не створює unsupported block errors;
- card може бути локальним HTML тільки всередині card node;
- button є native у Elementor і Gutenberg;
- image має перевірений asset або явний unresolved status;
- діагностика показує, де саме зникає кожен node;
- жоден компонент не визначається тільки за українським/англійським текстом.

## 15. Правила для наступного агента

1. Не змінювати legacy `site-generator.php`, якщо немає окремого прямого запиту.
2. Не повертати whole-page HTML widget.
3. Не додавати мовні словники як головний спосіб визначення component type.
4. Не виправляти Gutenberg проблему додаванням порожніх блоків без діагностики schema.
5. Не видаляти незрозумілі nodes мовчки — зберігати їх як `unknown`/`unresolved` із confidence.
6. Перед змінами читати schema pipeline і відповідний serializer.
7. Після змін запускати PHP/JS syntax checks.
8. Для serializer спочатку тестувати synthetic schema, потім реальний screenshot.
9. Усі нові типи компонентів додавати через Component Registry.
10. Вважати Page Schema головним джерелом правди, а Elementor/Gutenberg/HTML — адаптерами.
