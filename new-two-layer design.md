# New Two-Layer Design

## 1. Основна ідея

Page Generator не повинен будувати свою внутрішню логіку навколо Elementor або Gutenberg. Обидві системи мають власні обмеження:

- Elementor може обмежувати ширину, структуру контейнерів і доступні widgets;
- Gutenberg не має повного набору semantic components, зокрема універсальної Card;
- HTML widget зручний, але якщо використати його для всієї сторінки, зникає редагована структура;
- UI automation через RobotJS залежить від координат, zoom, viewport і поточного стану редактора.

Тому потрібен canonical internal format:

```text
Page Schema + Component Registry
```

Elementor, Gutenberg, власний runtime і static HTML — це лише різні exporters/renderers цього формату.

```text
Screenshot/Figma/video
→ Raw analysis
→ Semantic Page Schema
→ Own sandbox/editor
→ Own renderer
→ Export adapters
   ├── Own Runtime
   ├── Elementor
   ├── Gutenberg
   └── Static HTML
```

## 2. Два шари

### Шар 1 — власна пісочниця

Пісочниця є місцем, де генератор може працювати без обмежень WordPress page builder:

- повна ширина;
- власна система viewport;
- cards;
- grids;
- forms;
- tables;
- navigation;
- custom components;
- flex/grid/flow;
- absolute positioning у pixel-match mode;
- responsive breakpoints;
- z-index;
- assets;
- власні interactions.

Пісочниця не повинна зберігати готовий HTML як джерело правди. Вона зберігає schema, а DOM створюється власним renderer-ом.

### Шар 2 — export adapters

Одна canonical schema передається у потрібний target:

```text
Canonical Page Schema
├── Own DOM renderer
├── Elementor serializer
├── Gutenberg serializer
└── Static HTML/CSS/JS exporter
```

Це дозволяє спочатку отримати правильну структуру у власному середовищі, а вже потім вирішувати, яку частину можна без втрат передати в Elementor або Gutenberg.

## 3. Reference viewport і sandbox document

Ширина screenshot не повинна ставати постійною шириною сайту. Вона є reference viewport:

```javascript
const VIEWPORTS = {
    desktop: { width: 1440, height: 900 },
    laptop: { width: 1280, height: 800 },
    tablet: { width: 768, height: 1024 },
    mobile: { width: 390, height: 844 }
};
```

У документі потрібно розділити:

- `reference.width` — ширина джерельного screenshot;
- `reference.height` — висота джерельного screenshot;
- `viewport.width` — поточний preview viewport;
- `viewport.height` — поточна висота preview;
- `containerWidth` — логічна ширина контенту;
- `mode` — `responsive` або `pixel-match`.

Приклад:

```json
{
  "schemaVersion": 1,
  "reference": {
    "width": 1440,
    "height": 3200,
    "device": "desktop"
  },
  "viewport": {
    "width": 1440,
    "height": 900,
    "zoom": 1
  },
  "mode": "responsive",
  "root": {
    "type": "page",
    "children": []
  }
}
```

## 4. Повний сценарій роботи

1. Користувач відкриває власний Page Generator Editor.
2. Обирає screenshot, Figma frame або відеокадри.
3. Визначається reference viewport.
4. Запускаються OCR, OpenCV, color analysis і asset crop.
5. Raw detections зберігаються окремо від semantic schema.
6. Визначається spatial ownership: кожен text/region має одного логічного батька.
7. Будується Semantic Page Schema.
8. Schema нормалізується і проходить validation.
9. Schema завантажується у власний canvas.
10. Користувач бачить tree, canvas, reference, overlay, diff і confidence.
11. Користувач виправляє type, parent, text, color, asset, layout або position.
12. Власний renderer оновлює preview.
13. Користувач перевіряє desktop/tablet/mobile.
14. Запускається screenshot comparison.
15. Користувач вибирає target export.
16. Draft schema зберігається окремо від опублікованого output.

## 5. Власний editor

Рекомендований layout:

```text
┌─────────────────────────────────────────┐
│ Toolbar: viewport / mode / save / export│
├──────────────┬────────────────┬─────────┤
│ Layers tree  │ Canvas         │Inspector│
│              │                │         │
│ Page         │ reference      │ type    │
│  Header      │ generated      │ text    │
│  Hero        │ overlay        │ colors  │
│  Card grid   │ diff           │ layout  │
└──────────────┴────────────────┴─────────┘
```

Перший мінімальний editor повинен дозволяти:

- вибирати node;
- змінювати type;
- змінювати text;
- змінювати background/color;
- змінювати width/height/position;
- переміщати node між parents;
- видаляти та дублювати node;
- додавати section/card/button/text/image;
- робити undo/redo;
- зберігати draft schema;
- рендерити preview.

Для ізоляції стилів краще використовувати iframe. WordPress admin не повинен впливати на canvas CSS, а canvas CSS не повинен ламати admin UI.

## 6. Canonical Page Schema

Schema є головним джерелом правди, а не HTML:

```json
{
  "id": "card-1",
  "type": "card",
  "role": "content-card",
  "children": [
    {
      "id": "heading-1",
      "type": "heading",
      "text": "Житлові комплекси"
    },
    {
      "id": "text-1",
      "type": "text",
      "text": "Моніторинг шуму..."
    },
    {
      "id": "button-1",
      "type": "button",
      "text": "Детальніше"
    }
  ],
  "layout": {
    "mode": "flow",
    "direction": "column",
    "gap": 16
  },
  "style": {
    "background": "#ffffff",
    "color": "#202020",
    "borderRadius": 12,
    "padding": 24
  }
}
```

Для координат потрібно зберігати не лише `x/y`, а і coordinate space:

```json
{
  "bbox": {
    "x": 120,
    "y": 240,
    "width": 320,
    "height": 180
  },
  "coordinateSpace": "parent-local",
  "parentId": "section-1"
}
```

## 7. Component Registry

Component Registry — це єдиний контракт для кожного component type.

```javascript
const componentRegistry = {
    card: {
        roles: ['surface', 'content-card'],
        canContain: ['heading', 'text', 'image', 'button'],
        infer: inferCard,
        defaults: defaultCardSchema,
        validate: validateCard,
        renderDom: renderCard,
        serializeElementor: serializeCardToElementor,
        serializeGutenberg: serializeCardToGutenberg,
        renderStaticHtml: renderCardToHtml
    },
    button: {
        roles: ['primary-action', 'secondary-action'],
        canContain: [],
        infer: inferButtonFromGeometry,
        defaults: defaultButtonSchema,
        validate: validateButton,
        renderDom: renderButton,
        serializeElementor: serializeButtonToElementor,
        serializeGutenberg: serializeButtonToGutenberg,
        renderStaticHtml: renderButtonToHtml
    }
};
```

Registry має описувати:

- допустимі roles;
- допустимих children;
- defaults;
- inference;
- validator;
- власний DOM renderer;
- Elementor serializer;
- Gutenberg serializer;
- static exporter;
- inspector fields;
- responsive behavior;
- fallback policy;
- confidence policy.

### Навіщо Registry

Без registry логіка розпадається на десятки незалежних умов у JS і PHP. Через це frontend, Elementor і Gutenberg починають рендерити один node по-різному.

З registry:

```text
один component contract
→ власний renderer
→ Elementor adapter
→ Gutenberg adapter
→ HTML fallback adapter
→ validator
→ editor inspector
```

Це спрощує додавання card, badge, tabs, accordion, gallery або нового custom component.

## 8. Як фізично переносити schema у renderer

Найважливіше правило:

```text
schema не перетворюється одразу на Elementor/Gutenberg.
```

Спочатку існує renderer-neutral interface:

```javascript
renderDocument(schema, target, options)
```

Власний DOM renderer проходить дерево:

```javascript
function renderNode(node, context) {
    const definition = componentRegistry[node.type];
    if (!definition) return renderUnknownNode(node, context);
    return definition.renderDom(node, context);
}
```

`context` містить:

- parent element;
- viewport;
- reference dimensions;
- coordinate space;
- assets;
- selected node;
- breakpoint;
- rendering mode.

### Приклад card

```javascript
function renderCard(node, context) {
    const element = document.createElement('article');
    element.className = 'pg-card';
    applyLayout(element, node.layout, context);
    applyStyle(element, node.style, context);
    node.children.forEach(child => renderNode(child, {
        ...context,
        parent: element,
        parentNode: node
    }));
    context.parent.appendChild(element);
    return element;
}
```

DOM є лише результатом цього проходу. Після зміни schema renderer може знищити або оновити тільки потрібну частину дерева.

## 9. Export adapters і неминучі компроміси

Кожен target має власні обмеження. Не потрібно приховувати їх або ламати canonical schema.

### Власний runtime

Найбільше контролю:

```text
card → власний card renderer
grid → власний grid renderer
form → власний form renderer
```

Недолік: користувач повинен працювати у власному runtime/editor, а не в стандартному Elementor/Gutenberg UI.

### Elementor

Рекомендоване відображення:

```text
section/container → native container
heading → heading widget
text → text-editor
button → button widget
image → image widget
card/grid → nested containers
form/table/unsupported → local HTML widget
```

Компроміс:

- native widgets кращі для ручного редагування;
- складні компоненти можуть вимагати local HTML;
- pixel-perfect absolute layout не завжди добре переноситься у responsive Elementor;
- Elementor може мати різні settings keys у різних версіях.

### Gutenberg

Рекомендоване відображення:

```text
heading → core/heading
text → core/paragraph
button → core/button
image → core/image
section → core/group
card → local HTML або власний page-generator/card block
table → local HTML або власний block
form → local HTML або власний block
```

Компроміс:

- немає універсального native Card block;
- вручну складені block comments можуть давати validation errors;
- `serialize_block()` або власний зареєстрований block надійніші за довільний HTML;
- local HTML треба обмежувати одним складним node.

### Static HTML/CSS/JS

Має найвищу візуальну свободу:

```text
schema → HTML/CSS/JS bundle
```

Компроміс:

- немає native editor integration;
- потрібен окремий asset/runtime deployment;
- доступ до WordPress data та forms треба реалізовувати окремо.

## 10. Який renderer є головним

Головним повинен бути власний renderer:

```text
Canonical Schema
→ Own DOM renderer
```

Це reference implementation. Інші adapters повинні намагатися повторити його, але не змінювати schema під свої обмеження.

Приклад flow:

```text
1. card у schema має padding 24, radius 12, background #fff.
2. Own renderer показує точну card.
3. Elementor adapter шукає container settings.
4. Gutenberg adapter вибирає local HTML або custom block.
5. Static exporter генерує HTML/CSS.
```

Якщо target не підтримує властивість:

```json
{
  "exportWarnings": [
    {
      "nodeId": "card-1",
      "target": "gutenberg",
      "property": "responsiveAbsolutePosition",
      "action": "local-html-fallback"
    }
  ]
}
```

Не можна мовчки втрачати властивість.

## 11. Export plan

Перед export потрібно виконати:

```text
schema validation
→ target capability check
→ export warnings
→ adapter selection
→ serialization
→ post-export validation
→ screenshot comparison
```

Після export потрібно перевіряти:

### Elementor

- `_elementor_data` валідний JSON;
- є top-level containers;
- native widgets не порожні;
- HTML widget тільки у дозволених node types;
- немає whole-page HTML widget.

### Gutenberg

- block comments парні;
- core blocks мають очікувану структуру;
- немає unsupported custom blocks без registration;
- `parse_blocks()` не повертає пошкоджене дерево;
- немає validation errors у редакторі.

### Own runtime

- кожен node має renderer;
- unknown nodes явно позначені;
- assets завантажуються;
- responsive preview не створює неконтрольований overflow.

## 12. Де місце RobotJS

RobotJS не повинен генерувати сайт. Він залежить від screen coordinates і нестабільний між Windows/Linux, zoom і темами.

Основний порядок:

```text
schema → direct renderer/serializer/API
```

Для end-to-end перевірки краще Playwright:

```text
open editor
inspect DOM
check Navigator
save
open preview
compare screenshot
```

RobotJS можна залишити тільки як compatibility fallback для UI, де немає API або DOM-доступу.

## 13. Збереження у WordPress

Потрібно розділити draft і published/exported state:

```text
_page_generator_schema_draft
_page_generator_schema_published
_page_generator_export_target
_page_generator_export_warnings
```

Schema повинна містити:

```json
{
  "schemaVersion": 1,
  "editorVersion": "0.1.0",
  "updatedAt": "2026-10-11T02:00:00Z"
}
```

Це дасть можливість редагувати sandbox без негайного руйнування поточної Elementor/Gutenberg page.

## 14. Перший практичний milestone

Не потрібно одразу робити повний Elementor-аналог. Перший milestone:

1. Створити `componentRegistry`.
2. Створити renderer-neutral `renderNode`.
3. Перенести існуючу schema у власний canvas.
4. Додати tree selection.
5. Додати inspector для:
   - type;
   - text;
   - background;
   - color;
   - width;
   - height;
   - x/y.
6. Додати draft save/load.
7. Додати synthetic schema fixture.
8. Перевірити власний renderer на fixture.
9. Перевірити Elementor/Gutenberg adapters на тому самому fixture.
10. Лише потім переносити складні detector rules.

Критерій завершення:

```text
одна schema
→ власний DOM без втрат
→ Elementor native tree де можливо
→ Gutenberg core blocks де можливо
→ local fallback тільки для unsupported components
→ явні warnings для всіх втрат
```

## 15. Правила для наступного агента

1. Page Schema є джерелом правди.
2. Не будувати внутрішню модель навколо Elementor або Gutenberg.
3. Не повертати whole-page HTML widget.
4. Картку можна експортувати локальним HTML fallback.
5. Не визначати component type лише за словами OCR.
6. Не видаляти невпевнені nodes мовчки.
7. Додавати нові типи через Component Registry.
8. Власний renderer вважати reference implementation.
9. Export adapters повинні звітувати про втрати через warnings.
10. Спочатку тестувати synthetic schema, потім реальний screenshot.
11. Після змін перевіряти PHP/JS syntax.
12. Не змінювати legacy `site-generator.php` без окремого запиту.

## 16. Практичний ланцюжок: schema → renderer → export

Цей розділ фіксує, як саме дані повинні проходити через систему, щоб власна
пісочниця не перетворилася на ще одну оболонку навколо Elementor або Gutenberg.

### 16.1. Canonical schema

Page Schema є головним джерелом правди:

```json
{
  "type": "card",
  "style": {
    "background": "#ffffff",
    "padding": 24,
    "borderRadius": 12
  },
  "children": [
    {
      "type": "heading",
      "text": "Назва"
    },
    {
      "type": "button",
      "text": "Детальніше"
    }
  ]
}
```

Schema не повинна знати про Elementor widgets, Gutenberg blocks або конкретні
HTML-рядки. Вона описує структуру, layout, style, assets і behavior незалежно
від цільової платформи.

### 16.2. Власний renderer

Renderer проходить schema і шукає реалізацію типу у Component Registry:

```javascript
function renderNode(node, context) {
    const definition = componentRegistry[node.type];
    if (!definition) return renderUnknownNode(node, context);
    return definition.renderDom(node, context);
}
```

Для card послідовність така:

```text
card node
→ renderCard()
→ DOM article/div
→ застосування layout і style
→ renderNode() для кожного child
```

Приклад renderer-а:

```javascript
function renderCard(node, context) {
    const element = document.createElement('article');
    element.className = 'pg-card';
    applyLayout(element, node.layout, context);
    applyStyle(element, node.style, context);

    node.children.forEach(child => renderNode(child, {
        ...context,
        parent: element,
        parentNode: node
    }));

    context.parent.appendChild(element);
    return element;
}
```

DOM у цьому випадку є результатом рендерингу, а не постійною моделлю. Після
зміни schema renderer оновлює preview, не змінюючи canonical structure.

### 16.3. Export adapters

Одна schema може мати кілька виходів:

```text
Page Schema
├── власний DOM renderer
├── Elementor serializer
├── Gutenberg serializer
└── static HTML/CSS/JS exporter
```

Приклад для одного `card`:

```text
Own runtime → власний Card DOM
Elementor    → Container + Heading + Button
Gutenberg    → core/group або локальний wp:html
Static HTML  → article/div + CSS
```

Усі ці результати походять з однієї schema. Якщо target не підтримує певну
властивість, adapter не повинен змінювати schema або мовчки її втрачати. Він
повинен створити warning і вибрати дозволений fallback:

```json
{
  "nodeId": "card-1",
  "target": "gutenberg",
  "property": "customResponsiveLayout",
  "action": "local-html-fallback"
}
```

### 16.4. Чому HTML fallback не є проблемою

Проблема виникає не через HTML, а через використання одного HTML widget для
всієї сторінки:

```text
Page
└── один HTML widget
```

Допустима модель є локальною:

```text
Page Schema
├── native heading
├── native button
├── native image
├── local HTML card
└── native paragraph
```

У такій моделі HTML fallback:

- використовується лише для одного складного або непідтримуваного node;
- не замінює Page Schema;
- може бути повторно згенерований після редагування schema;
- не заважає іншим компонентам залишатися native;
- супроводжується export warning.

### 16.5. Послідовність export

Кожен export повинен проходити однаковий контрольований pipeline:

```text
schema validation
→ target capability check
→ export warnings
→ adapter selection
→ serialization
→ post-export validation
→ screenshot comparison
```

Для Elementor потрібно перевірити `_elementor_data`, native widgets і
відсутність whole-page HTML widget. Для Gutenberg потрібно перевірити структуру
block comments, `parse_blocks()` і відсутність незареєстрованих блоків. Для
власного runtime потрібно перевірити, що кожен node має renderer, а невідомі
типи явно позначені.

### 16.6. Що будувати першим

Перший робочий вертикальний зріз повинен виглядати так:

```text
synthetic schema
→ Component Registry
→ renderNode()
→ власний canvas
→ редагування node
→ draft save/load
→ Elementor/Gutenberg export
→ post-export validation
```

Тільки після перевірки цього циклу слід переносити додаткові OCR/OpenCV
detectors. Так можна відокремити проблеми аналізу screenshot від проблем
renderer-а та export adapters.
