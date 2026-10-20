(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PageGeneratorDetectors = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function colorDistance(data, offset, seed) {
        return Math.abs(data[offset] - seed[0]) + Math.abs(data[offset + 1] - seed[1]) + Math.abs(data[offset + 2] - seed[2]);
    }

    function luminance(color) {
        return color[0] * .299 + color[1] * .587 + color[2] * .114;
    }

    function saturation(color) {
        return Math.max(color[0], color[1], color[2]) - Math.min(color[0], color[1], color[2]);
    }

    function hex(color) {
        return '#' + color.map(function (value) { return value.toString(16).padStart(2, '0'); }).join('');
    }

    // Connected regions of one flat colour: cards, inputs, buttons and badges are all such surfaces.
    function detectSurfaces(data, width, height, options) {
        var tolerance = options && options.tolerance || 10;
        var minPixels = options && options.minPixels || 300;
        var labels = new Int32Array(width * height);
        var stack = new Int32Array(width * height);
        var regions = [];
        for (var start = 0; start < labels.length; start += 1) {
            if (labels[start]) continue;
            var seedOffset = start * 4;
            var seed = [data[seedOffset], data[seedOffset + 1], data[seedOffset + 2]];
            var id = regions.length + 1;
            var top = 0;
            var count = 0;
            var minX = width; var maxX = 0; var minY = height; var maxY = 0;
            stack[top++] = start;
            labels[start] = id;
            while (top) {
                var index = stack[--top];
                var x = index % width;
                var y = (index - x) / width;
                count += 1;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (x > 0 && !labels[index - 1] && colorDistance(data, (index - 1) * 4, seed) <= tolerance) { labels[index - 1] = id; stack[top++] = index - 1; }
                if (x < width - 1 && !labels[index + 1] && colorDistance(data, (index + 1) * 4, seed) <= tolerance) { labels[index + 1] = id; stack[top++] = index + 1; }
                if (y > 0 && !labels[index - width] && colorDistance(data, (index - width) * 4, seed) <= tolerance) { labels[index - width] = id; stack[top++] = index - width; }
                if (y < height - 1 && !labels[index + width] && colorDistance(data, (index + width) * 4, seed) <= tolerance) { labels[index + width] = id; stack[top++] = index + width; }
            }
            regions.push({ id: id, color: seed, count: count, x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
        }
        var surfaces = regions.filter(function (region) {
            var area = region.width * region.height;
            return region.count >= minPixels && region.width >= 24 && region.height >= 12 &&
                region.count / area >= .45 && !(region.width >= width * .98 && region.height >= height * .98);
        }).map(function (region) {
            var inside = function (px, py) {
                return labels[py * width + px] === region.id;
            };
            var right = region.x + region.width - 1;
            var bottom = region.y + region.height - 1;
            var rounded = [
                inside(region.x, region.y), inside(right, region.y), inside(region.x, bottom), inside(right, bottom)
            ].filter(function (value) { return !value; }).length >= 3;
            // Corner radius from where the top row starts: on a circle of radius r the first pixel of the top row sits r - sqrt(r - .25) in from the edge,
            // so r is recovered from that offset. A row that never starts within reach is a pill (half the height).
            var radius = 0;
            if (rounded) {
                var limit = Math.floor(Math.min(region.width, region.height) / 2);
                var topRow = region.y * width;
                var first = -1;
                for (var scan = region.x; scan < region.x + Math.min(region.width, limit + 3); scan += 1) {
                    if (labels[topRow + scan] === region.id) { first = scan; break; }
                }
                if (first < 0) {
                    // Only something button-sized can be a pill; a large irregular area keeps a modest default.
                    radius = region.height <= width * .09 ? limit : 6;
                } else {
                    var offset = first - region.x;
                    radius = offset;
                    for (var step = 0; step < 8; step += 1) radius = offset + Math.sqrt(Math.max(0, radius - .25));
                    radius = Math.min(limit, Math.round(radius));
                }
                radius = Math.max(2, radius);
            }
            return {
                x: region.x, y: region.y, width: region.width, height: region.height,
                fill: region.color, background: hex(region.color), rounded: radius,
                solidity: region.count / (region.width * region.height)
            };
        });
        surfaces.forEach(function (surface, index) {
            var parent = null;
            surfaces.forEach(function (other, otherIndex) {
                if (otherIndex === index) return;
                var contains = other.x <= surface.x + 1 && other.y <= surface.y + 1 &&
                    other.x + other.width >= surface.x + surface.width - 1 &&
                    other.y + other.height >= surface.y + surface.height - 1 &&
                    other.width * other.height > surface.width * surface.height * 1.1;
                if (contains && (!parent || other.width * other.height < parent.width * parent.height)) parent = other;
            });
            surface.parent = parent ? surfaces.indexOf(parent) : -1;
        });
        return surfaces;
    }

    function ringSamples(surface, data, width, height) {
        var gap = Math.min(12, Math.max(4, Math.round(Math.min(surface.width, surface.height) * .1)));
        var samples = [];
        var sample = function (x, y) {
            if (x < 0 || y < 0 || x >= width || y >= height) return;
            var offset = (y * width + x) * 4;
            samples.push([data[offset], data[offset + 1], data[offset + 2]]);
        };
        var step = Math.max(1, Math.floor((surface.width + surface.height) / 80));
        var sides = [[], [], [], []];
        var sampleSide = function (side, x, y) {
            var before = samples.length;
            sample(x, y);
            if (samples.length > before) sides[side].push(samples[samples.length - 1]);
        };
        for (var x = surface.x; x < surface.x + surface.width; x += step) {
            sampleSide(0, x, surface.y - gap);
            sampleSide(1, x, surface.y + surface.height + gap - 1);
        }
        for (var y = surface.y; y < surface.y + surface.height; y += step) {
            sampleSide(2, surface.x - gap, y);
            sampleSide(3, surface.x + surface.width + gap - 1, y);
        }
        samples.sides = sides;
        return samples;
    }

    function median(samples) {
        if (!samples.length) return [255, 255, 255];
        return [0, 1, 2].map(function (channel) {
            var values = samples.map(function (color) { return color[channel]; }).sort(function (a, b) { return a - b; });
            return values[Math.floor(values.length / 2)];
        });
    }

    // Share of pixels just outside the box that match the surrounding surface (separates real plates from photo patches).
    function surroundMatch(samples, fill) {
        if (!samples.length) return 0;
        var share = function (list) {
            return list.length ? list.filter(function (color) {
                return Math.abs(color[0] - fill[0]) + Math.abs(color[1] - fill[1]) + Math.abs(color[2] - fill[2]) <= 36;
            }).length / list.length : 0;
        };
        var overall = share(samples);
        // A plate with a gradient is only flood-filled part of the way, so one edge can still touch the plate itself; three clean sides are enough.
        var cleanSides = (samples.sides || []).filter(function (side) { return share(side) >= .85; }).length;
        return cleanSides >= 3 ? Math.max(overall, .6) : overall;
    }

    // A thin line around a flat surface: the fill alone cannot tell a white field on a white page from empty space. Each side is scanned a few
    // pixels outward at several points; the line is real when most points on every side hold a pixel clearly different from the fill.
    function detectOutline(surface, data, width, height) {
        var fill = surface.fill;
        var reach = 4;
        var positions = [.2, .35, .5, .65, .8];
        var sides = [
            { dx: 0, dy: -1, along: 'x', base: surface.y, span: surface.width, start: surface.x },
            { dx: 0, dy: 1, along: 'x', base: surface.y + surface.height - 1, span: surface.width, start: surface.x },
            { dx: -1, dy: 0, along: 'y', base: surface.x, span: surface.height, start: surface.y },
            { dx: 1, dy: 0, along: 'y', base: surface.x + surface.width - 1, span: surface.height, start: surface.y }
        ];
        var lines = [];
        for (var sideIndex = 0; sideIndex < sides.length; sideIndex += 1) {
            var side = sides[sideIndex];
            var hits = 0;
            positions.forEach(function (position) {
                var along = side.start + Math.round(side.span * position);
                var best = null;
                var bestStep = 0;
                for (var offset = 1; offset <= reach; offset += 1) {
                    var x = side.along === 'x' ? along : side.base + side.dx * offset;
                    var y = side.along === 'x' ? side.base + side.dy * offset : along;
                    if (x < 0 || y < 0 || x >= width || y >= height) continue;
                    var index = (y * width + x) * 4;
                    var pixel = [data[index], data[index + 1], data[index + 2]];
                    var step = Math.abs(pixel[0] - fill[0]) + Math.abs(pixel[1] - fill[1]) + Math.abs(pixel[2] - fill[2]);
                    if (step > bestStep) { bestStep = step; best = pixel; }
                }
                if (best && bestStep >= 9) { hits += 1; lines.push({ side: sideIndex, step: bestStep, pixel: best }); }
            });
            if (hits < 4) return null;
        }
        var darkest = lines.reduce(function (winner, line) { return line.step > winner.step ? line : winner; }, lines[0]);
        return { color: hex(darkest.pixel), step: darkest.step };
    }

    // Small graphics (icons, logos, avatars): connected clusters of pixels that differ from the local background. The background of each tile is its
    // commonest colour; tiles that are mostly ink are photos or illustrations and are left to the photo detector. Anything that falls inside a word box
    // (`skip`) is text and is ignored, so only the non-letter shapes remain.
    function detectIconBlobs(data, width, height, skip, options) {
        var opts = options || {};
        var tile = opts.tile || 48;
        var inkDistance = opts.inkDistance || 60;
        var minSize = opts.minSize || Math.max(12, Math.round(width * .005));
        var maxSize = opts.maxSize || Math.round(width * .05);
        var join = opts.join || Math.max(2, Math.round(width * .0012));
        var cols = Math.ceil(width / tile);
        var rows = Math.ceil(height / tile);
        var background = new Uint8Array(cols * rows * 3);
        var mostlyInk = new Uint8Array(cols * rows);
        for (var ty = 0; ty < rows; ty += 1) {
            for (var tx = 0; tx < cols; tx += 1) {
                var counts = {};
                var bestKey = null;
                var best = 0;
                var total = 0;
                var yEnd = Math.min(height, (ty + 1) * tile);
                var xEnd = Math.min(width, (tx + 1) * tile);
                for (var y = ty * tile; y < yEnd; y += 2) {
                    for (var x = tx * tile; x < xEnd; x += 2) {
                        var o = (y * width + x) * 4;
                        var key = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
                        var count = (counts[key] || 0) + 1;
                        counts[key] = count;
                        total += 1;
                        if (count > best) { best = count; bestKey = key; }
                    }
                }
                var cell = (ty * cols + tx) * 3;
                background[cell] = ((bestKey >> 10) << 3) + 4;
                background[cell + 1] = (((bestKey >> 5) & 31) << 3) + 4;
                background[cell + 2] = ((bestKey & 31) << 3) + 4;
                mostlyInk[ty * cols + tx] = best / total < .25 ? 1 : 0;
            }
        }
        var mask = new Uint8Array(width * height);
        for (var py = 0; py < height; py += 1) {
            for (var px = 0; px < width; px += 1) {
                var tileIndex = Math.floor(py / tile) * cols + Math.floor(px / tile);
                if (mostlyInk[tileIndex]) continue;
                var cellOffset = tileIndex * 3;
                var pixel = (py * width + px) * 4;
                if (Math.abs(data[pixel] - background[cellOffset]) + Math.abs(data[pixel + 1] - background[cellOffset + 1]) + Math.abs(data[pixel + 2] - background[cellOffset + 2]) > inkDistance) mask[py * width + px] = 1;
            }
        }
        (skip || []).forEach(function (box) {
            var x0 = Math.max(0, box.x - 2);
            var y0 = Math.max(0, box.y - 2);
            var x1 = Math.min(width, box.x + box.width + 2);
            var y1 = Math.min(height, box.y + box.height + 2);
            for (var sy = y0; sy < y1; sy += 1) {
                for (var sx = x0; sx < x1; sx += 1) mask[sy * width + sx] = 0;
            }
        });
        // Close small gaps so one icon made of several strokes is a single component.
        var closed = new Uint8Array(width * height);
        for (var cy = 0; cy < height; cy += 1) {
            for (var cx = 0; cx < width; cx += 1) {
                if (!mask[cy * width + cx]) continue;
                var ya = Math.max(0, cy - join), yb = Math.min(height - 1, cy + join);
                var xa = Math.max(0, cx - join), xb = Math.min(width - 1, cx + join);
                for (var dy = ya; dy <= yb; dy += 1) {
                    for (var dx = xa; dx <= xb; dx += 1) closed[dy * width + dx] = 1;
                }
            }
        }
        var seen = new Uint8Array(width * height);
        var stack = new Int32Array(width * height);
        var blobs = [];
        for (var start = 0; start < closed.length; start += 1) {
            if (!closed[start] || seen[start]) continue;
            var top = 0;
            var minX = width, maxX = 0, minY = height, maxY = 0, ink = 0;
            stack[top++] = start;
            seen[start] = 1;
            while (top) {
                var index = stack[--top];
                var bx = index % width;
                var by = (index - bx) / width;
                if (mask[index]) ink += 1;
                if (bx < minX) minX = bx;
                if (bx > maxX) maxX = bx;
                if (by < minY) minY = by;
                if (by > maxY) maxY = by;
                if (bx > 0 && closed[index - 1] && !seen[index - 1]) { seen[index - 1] = 1; stack[top++] = index - 1; }
                if (bx < width - 1 && closed[index + 1] && !seen[index + 1]) { seen[index + 1] = 1; stack[top++] = index + 1; }
                if (by > 0 && closed[index - width] && !seen[index - width]) { seen[index - width] = 1; stack[top++] = index - width; }
                if (by < height - 1 && closed[index + width] && !seen[index + width]) { seen[index + width] = 1; stack[top++] = index + width; }
            }
            var w = maxX - minX + 1 - join * 2;
            var h = maxY - minY + 1 - join * 2;
            if (w < minSize || h < minSize || w > maxSize || h > maxSize) continue;
            var ratio = w / h;
            if (ratio < .4 || ratio > 2.5) continue;
            var fillShare = ink / (w * h);
            if (fillShare < .08 || fillShare > .985) continue;
            blobs.push({ x: minX + join, y: minY + join, width: w, height: h, ink: ink, fillShare: fillShare });
        }
        return blobs;
    }

    // Photographs and illustrations as pixels. Everything that differs from its local background is "ink"; ink is joined across small gaps into regions, and a
    // region counts as a picture when it is large and holds many distinct colours with no dominant one (a button or card is a few flat colours, text is two).
    // Ink under OCR word boxes is ignored, so lines of text never form a region of their own.
    function detectPhotoRegions(data, width, height, skip, options) {
        var opts = options || {};
        var cell = opts.cell || 8;
        var tile = 48;
        var inkDistance = opts.inkDistance || 45;
        var cols = Math.ceil(width / cell);
        var rows = Math.ceil(height / cell);
        // Local background: the commonest 5-bit colour of each 48 px tile.
        var tCols = Math.ceil(width / tile);
        var tRows = Math.ceil(height / tile);
        var background = new Uint8Array(tCols * tRows * 3);
        for (var ty = 0; ty < tRows; ty += 1) {
            for (var tx = 0; tx < tCols; tx += 1) {
                var counts = {};
                var bestKey = 0, best = 0;
                var yEnd = Math.min(height, (ty + 1) * tile), xEnd = Math.min(width, (tx + 1) * tile);
                for (var y = ty * tile; y < yEnd; y += 2) {
                    for (var x = tx * tile; x < xEnd; x += 2) {
                        var o = (y * width + x) * 4;
                        var key = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
                        var count = (counts[key] || 0) + 1;
                        counts[key] = count;
                        if (count > best) { best = count; bestKey = key; }
                    }
                }
                var b = (ty * tCols + tx) * 3;
                background[b] = ((bestKey >> 10) << 3) + 4;
                background[b + 1] = (((bestKey >> 5) & 31) << 3) + 4;
                background[b + 2] = ((bestKey & 31) << 3) + 4;
            }
        }
        var inkCell = new Uint8Array(cols * rows);
        for (var cy = 0; cy < rows; cy += 1) {
            for (var cx = 0; cx < cols; cx += 1) {
                var ink = 0, samples = 0;
                var py1 = Math.min(height, (cy + 1) * cell), px1 = Math.min(width, (cx + 1) * cell);
                for (var py = cy * cell; py < py1; py += 2) {
                    for (var px = cx * cell; px < px1; px += 2) {
                        var bg = (Math.floor(py / tile) * tCols + Math.floor(px / tile)) * 3;
                        var q = (py * width + px) * 4;
                        samples += 1;
                        if (Math.abs(data[q] - background[bg]) + Math.abs(data[q + 1] - background[bg + 1]) + Math.abs(data[q + 2] - background[bg + 2]) > inkDistance) ink += 1;
                    }
                }
                if (samples && ink / samples >= .12) inkCell[cy * cols + cx] = 1;
            }
        }
        (skip || []).forEach(function (box) {
            var c0 = Math.max(0, Math.floor(box.x / cell) - 1), c1 = Math.min(cols - 1, Math.floor((box.x + box.width) / cell) + 1);
            var r0 = Math.max(0, Math.floor(box.y / cell) - 1), r1 = Math.min(rows - 1, Math.floor((box.y + box.height) / cell) + 1);
            for (var r = r0; r <= r1; r += 1) {
                for (var c = c0; c <= c1; c += 1) inkCell[r * cols + c] = 0;
            }
        });
        // Opening: drop ink thinner than three cells (a seam where two sections meet, a rule line) so it cannot bridge unrelated things.
        var eroded = new Uint8Array(cols * rows);
        for (var ey = 1; ey < rows - 1; ey += 1) {
            for (var ex = 1; ex < cols - 1; ex += 1) {
                var solid = 1;
                for (var oy = -1; oy <= 1 && solid; oy += 1) {
                    for (var ox = -1; ox <= 1; ox += 1) {
                        if (!inkCell[(ey + oy) * cols + ex + ox]) { solid = 0; break; }
                    }
                }
                eroded[ey * cols + ex] = solid;
            }
        }
        inkCell = new Uint8Array(cols * rows);
        for (var ry = 1; ry < rows - 1; ry += 1) {
            for (var rx = 1; rx < cols - 1; rx += 1) {
                if (!eroded[ry * cols + rx]) continue;
                for (var py2 = -1; py2 <= 1; py2 += 1) {
                    for (var px2 = -1; px2 <= 1; px2 += 1) inkCell[(ry + py2) * cols + rx + px2] = 1;
                }
            }
        }
        var bridge = opts.bridge || 4;
        var joined = new Uint8Array(cols * rows);
        for (var jy = 0; jy < rows; jy += 1) {
            for (var jx = 0; jx < cols; jx += 1) {
                if (!inkCell[jy * cols + jx]) continue;
                for (var dy = Math.max(0, jy - bridge); dy <= Math.min(rows - 1, jy + bridge); dy += 1) {
                    for (var dx = Math.max(0, jx - bridge); dx <= Math.min(cols - 1, jx + bridge); dx += 1) joined[dy * cols + dx] = 1;
                }
            }
        }
        var seen = new Uint8Array(cols * rows);
        var regions = [];
        var minSize = opts.minSize || width * .06;
        for (var start = 0; start < joined.length; start += 1) {
            if (!joined[start] || seen[start]) continue;
            var stack = [start];
            seen[start] = 1;
            var minC = cols, maxC = 0, minR = rows, maxR = 0, cells = 0;
            while (stack.length) {
                var index = stack.pop();
                var c = index % cols, r = (index - c) / cols;
                if (inkCell[index]) {
                    cells += 1;
                    if (c < minC) minC = c;
                    if (c > maxC) maxC = c;
                    if (r < minR) minR = r;
                    if (r > maxR) maxR = r;
                }
                for (var ny = r - 1; ny <= r + 1; ny += 1) {
                    for (var nx = c - 1; nx <= c + 1; nx += 1) {
                        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                        var next = ny * cols + nx;
                        if (joined[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
                    }
                }
            }
            if (!cells) continue;
            var box = { x: minC * cell, y: minR * cell, width: Math.min(width, (maxC + 1) * cell) - minC * cell, height: Math.min(height, (maxR + 1) * cell) - minR * cell };
            var fill = cells / ((maxC - minC + 1) * (maxR - minR + 1));
            if (box.width < minSize || box.height < minSize || fill < (opts.minFill || .12)) continue;
            if (box.width * box.height > width * height * (opts.maxShare || .6)) continue;
            // Colour variety of the region's ink: a picture has many distinct shades and none dominates.
            var shades = {};
            var shadeCount = 0, top = 0, inkSamples = 0;
            for (var sy = box.y; sy < box.y + box.height; sy += 3) {
                for (var sx = box.x; sx < box.x + box.width; sx += 3) {
                    if (!inkCell[Math.floor(sy / cell) * cols + Math.floor(sx / cell)]) continue;
                    var so = (sy * width + sx) * 4;
                    var shade = ((data[so] >> 3) << 10) | ((data[so + 1] >> 3) << 5) | (data[so + 2] >> 3);
                    var seenCount = (shades[shade] || 0) + 1;
                    if (seenCount === 1) shadeCount += 1;
                    shades[shade] = seenCount;
                    if (seenCount > top) top = seenCount;
                    inkSamples += 1;
                }
            }
            if (shadeCount < (opts.minShades || 60) || top / Math.max(1, inkSamples) > (opts.maxDominant || .5)) continue;
            // A word lying partly on the picture belongs to it (it is baked into the image); stretch the box over such words so none is cut in half.
            for (var pass = 0; pass < 2; pass += 1) {
                (skip || []).forEach(function (word) {
                    var w = Math.min(box.x + box.width, word.x + word.width) - Math.max(box.x, word.x);
                    var h = Math.min(box.y + box.height, word.y + word.height) - Math.max(box.y, word.y);
                    if (w <= 0 || h <= 0 || (w * h) / (word.width * word.height) < .25 || (w * h) / (word.width * word.height) > .98) return;
                    var left = Math.min(box.x, word.x), top = Math.min(box.y, word.y);
                    var right = Math.max(box.x + box.width, word.x + word.width), bottom = Math.max(box.y + box.height, word.y + word.height);
                    box.x = Math.max(0, left); box.y = Math.max(0, top);
                    box.width = Math.min(width, right) - box.x; box.height = Math.min(height, bottom) - box.y;
                });
            }
            box.fill = fill;
            box.shades = shadeCount;
            regions.push(box);
        }
        return regions;
    }

    // A border or divider line that OCR read as a character: a bar or a lone "I", "l", "1" far taller than it is wide. Real letters are never that thin.
    function isRuleWord(word) {
        var text = String(word.text || '').trim();
        if (!text || text.length > 2 || !/^[|¦!Il1]+$/.test(text)) return false;
        return word.height >= Math.max(1, word.width) * 8;
    }

    // Several distinct hues among the saturated pixels: a multi-colour logo, never a line of text.
    function isColourful(data, width, blob) {
        var buckets = new Array(12).fill(0);
        var saturated = 0;
        for (var y = blob.y; y < blob.y + blob.height; y += 1) {
            for (var x = blob.x; x < blob.x + blob.width; x += 1) {
                var o = (y * width + x) * 4;
                var r = data[o], g = data[o + 1], b = data[o + 2];
                var max = Math.max(r, g, b), min = Math.min(r, g, b);
                if (max - min < 80) continue;
                var hue = max === r ? ((g - b) / (max - min) + 6) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
                buckets[Math.min(11, Math.floor(hue * 2))] += 1;
                saturated += 1;
            }
        }
        // Sub-pixel anti-aliasing puts red and blue fringes on ordinary text; a real multi-colour logo is saturated over much of its area.
        if (saturated < 20 || saturated < blob.width * blob.height * .3) return false;
        return buckets.filter(function (count) { return count >= saturated * .1; }).length >= 3;
    }

    // Icons that are not text. Only words longer than three characters protect their pixels; short ones are judged per picture. OCR reads pictures as junk
    // "words" ("[", "@", a lone "G"): one character lying on a picture, or up to three characters lying on a multi-colour logo, is dropped and the picture kept.
    // A short word that is real text ("in", "to", "US") owns its glyphs, so that cluster is not an icon.
    function findIcons(data, width, height, words) {
        var overlap = function (inner, outer) {
            var w = Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x);
            var h = Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y);
            return w > 0 && h > 0 ? (w * h) / (inner.width * inner.height) : 0;
        };
        var length = function (word) { return String(word.text || '').trim().length; };
        // A one-character word is junk when it is a symbol, or a letter or digit standing alone; a letter inside a line of text ("в", "и", "a") is a real word.
        var inline = function (word) {
            return words.some(function (other) {
                if (other === word) return false;
                var sameLine = Math.abs((other.y + other.height / 2) - (word.y + word.height / 2)) <= word.height * .6;
                var gap = Math.max(other.x - (word.x + word.width), word.x - (other.x + other.width));
                return sameLine && gap <= Math.max(word.height, 14) * 1.5;
            });
        };
        var isLoneJunk = function (word) {
            if (length(word) > 1) return false;
            return !/[\p{L}\p{N}]/u.test(String(word.text || '')) || !inline(word);
        };
        var shortWords = words.filter(function (word) { return length(word) <= 3; });
        var longWords = words.filter(function (word) { return length(word) > 3; });
        var icons = [];
        var droppedWords = [];
        detectIconBlobs(data, width, height, longWords).forEach(function (blob) {
            var covered = shortWords.filter(function (word) { return overlap(word, blob) >= .4 || overlap(blob, word) >= .6; });
            if (!covered.length) { icons.push(blob); return; }
            var colourful = isColourful(data, width, blob);
            var junk = covered.every(function (word) { return isLoneJunk(word) || colourful; });
            if (!junk) return;
            icons.push(blob);
            covered.forEach(function (word) { droppedWords.push(word); });
        });
        return { icons: icons, droppedWords: droppedWords };
    }

    // Geometry and colour only; nothing here reads text. Sizes are relative to page width (screenshots may be 2x).
    function classifySurfaces(surfaces, pageWidth, data, height) {
        var unit = pageWidth / 100;
        surfaces.forEach(function (surface) {
            var parent = surface.parent >= 0 ? surfaces[surface.parent] : null;
            var samples = data ? ringSamples(surface, data, pageWidth, height) : [];
            var parentFill = parent ? parent.fill : median(samples);
            var contrast = Math.abs(luminance(surface.fill) - luminance(parentFill)) + (saturation(surface.fill) - saturation(parentFill)) * .5;
            var colorStep = Math.abs(surface.fill[0] - parentFill[0]) + Math.abs(surface.fill[1] - parentFill[1]) + Math.abs(surface.fill[2] - parentFill[2]);
            var ratio = surface.width / surface.height;
            var around = data ? surroundMatch(samples, parentFill) : 1;
            surface.kind = 'surface';
            if (data && contrast < 3 && ratio >= 3 && surface.height >= unit * 2.5 && surface.height <= unit * 6 && surface.width >= unit * 12) {
                var outline = detectOutline(surface, data, pageWidth, height);
                if (outline) { surface.outlined = true; surface.borderColor = outline.color; }
            }
            if (around < .6) return;
            // A vivid, high-contrast pill is a call-to-action button, not a status chip; chips are pastel or small.
            var vividPill = contrast >= 70 && saturation(surface.fill) >= 60 && surface.height >= unit * 2.3;
            if (!vividPill && surface.height >= unit * 1.1 && surface.height <= unit * 4.2 && surface.width <= unit * 22 && ratio >= 1.8 &&
                contrast >= 12 && surface.rounded && surface.width * surface.height <= unit * unit * 70) {
                surface.kind = 'badge';
            } else if (surface.height >= unit * 1.6 && surface.height <= unit * 9 && surface.width >= unit * 6 && ratio >= 1.8 &&
                contrast >= 70 && saturation(surface.fill) >= 60) {
                surface.kind = 'button';
            } else if (surface.height >= unit * 2.5 && surface.height <= unit * 24 && surface.width >= unit * 12 && ratio >= 3 &&
                contrast >= 3 && contrast < 60 && parent && luminance(parentFill) >= 230) {
                surface.kind = 'input-candidate';
            } else if (surface.height >= unit * 6 && surface.height <= unit * 14 && surface.width >= unit * 12 && ratio >= 1.8 && ratio < 3 &&
                contrast >= 3 && contrast < 60 && parent && luminance(parentFill) >= 230) {
                // A textarea is taller than a field and is trusted by its row, not by a column of siblings.
                surface.kind = 'input-candidate';
                surface.tall = true;
            } else if (surface.height >= unit * 5 && surface.width >= unit * 25 && ((luminance(surface.fill) >= 235 && colorStep >= 9) || colorStep >= 60)) {
                // A light card needs only a faint step from its page; a dark or coloured panel is unmistakable, so any strong step qualifies.

                surface.kind = 'card';
            }
        });
        // An input is only trusted when similar fields repeat in one column.
        surfaces.forEach(function (surface) {
            if (surface.kind !== 'input-candidate') return;
            var siblings = surfaces.filter(function (other) {
                if (other === surface || other.kind !== 'input-candidate' || other.parent !== surface.parent) return false;
                if (surface.tall) return other.y < surface.y + surface.height && other.y + other.height > surface.y;
                return Math.abs(other.x - surface.x) <= unit && Math.abs(other.width - surface.width) <= unit;
            });
            if (!siblings.length) surface.kind = 'surface';
        });
        surfaces.forEach(function (surface) {
            if (surface.kind === 'input-candidate') surface.kind = 'input';
        });
        return surfaces;
    }

    // Short same-height lines on a common x or y axis with even spacing are a menu, whatever they say.
    function detectLineRuns(lines) {
        var usable = lines.filter(function (line) { return line.width <= 360 && line.height >= 8; });
        var runs = [];
        ['column', 'row'].forEach(function (axis) {
            var groups = [];
            usable.slice().sort(function (a, b) { return axis === 'column' ? a.y - b.y : a.x - b.x; }).forEach(function (line) {
                var group = groups.find(function (candidate) {
                    var last = candidate[candidate.length - 1];
                    var sameAxis = axis === 'column' ? Math.abs(last.x - line.x) <= 6 : Math.abs((last.y + last.height / 2) - (line.y + line.height / 2)) <= 6;
                    var similarSize = Math.abs(last.height - line.height) <= Math.max(8, last.height * .5);
                    var gap = axis === 'column' ? line.y - (last.y + last.height) : line.x - (last.x + last.width);
                    return sameAxis && similarSize && gap > 0 && gap <= (axis === 'column' ? 60 : 160);
                });
                if (group) group.push(line); else groups.push([line]);
            });
            groups.forEach(function (group) {
                if (group.length < 3) return;
                var steps = [];
                for (var index = 1; index < group.length; index += 1) {
                    steps.push(axis === 'column' ? group[index].y - group[index - 1].y : group[index].x - group[index - 1].x);
                }
                var mean = steps.reduce(function (sum, value) { return sum + value; }, 0) / steps.length;
                var even = axis === 'column'
                    ? steps.every(function (step) { return Math.abs(step - mean) <= Math.max(6, mean * .25); })
                    : steps.every(function (step) { return step > 0; });
                if (even) runs.push({ axis: axis, items: group });
            });
        });
        return runs;
    }

    // UI regions are dominated by a few flat colours; photos are not. Measured: photo ~0.45, UI >= 0.93.
    function dominantShare(data, width, box) {
        var bins = new Map();
        var total = 0;
        var step = Math.max(1, Math.floor(Math.min(box.width, box.height) / 60));
        for (var y = box.y; y < box.y + box.height; y += step) {
            for (var x = box.x; x < box.x + box.width; x += step) {
                var offset = (y * width + x) * 4;
                var key = ((data[offset] >> 4) << 8) | ((data[offset + 1] >> 4) << 4) | (data[offset + 2] >> 4);
                bins.set(key, (bins.get(key) || 0) + 1);
                total += 1;
            }
        }
        if (total < 16) return 1;
        var top = Array.from(bins.values()).sort(function (a, b) { return b - a; }).slice(0, 8);
        return top.reduce(function (sum, count) { return sum + count; }, 0) / total;
    }

    function isPhotographic(data, width, box) {
        return dominantShare(data, width, box) < .7;
    }

    // OCR words -> lines. Rows are found by vertical centre, then each row is split where a large horizontal gap
    // separates columns (table cells, badges). Words inside a line are always ordered by x.
    function groupWordsIntoLines(words) {
        var rows = [];
        words.slice().sort(function (a, b) {
            return (a.y + a.height / 2) - (b.y + b.height / 2) || a.x - b.x;
        }).forEach(function (word) {
            var center = word.y + word.height / 2;
            var row = rows.find(function (candidate) {
                return Math.abs(candidate.center - center) <= Math.max(4, Math.min(candidate.height, word.height) * .5);
            });
            if (!row) {
                row = { center: center, height: word.height, words: [] };
                rows.push(row);
            }
            row.words.push(word);
            row.height = Math.min(row.height, word.height);
            row.center = row.words.reduce(function (sum, item) { return sum + item.y + item.height / 2; }, 0) / row.words.length;
        });
        var lines = [];
        rows.forEach(function (row) {
            var ordered = row.words.slice().sort(function (a, b) { return a.x - b.x; });
            var segments = [[ordered[0]]];
            for (var index = 1; index < ordered.length; index += 1) {
                var previous = ordered[index - 1];
                var gap = ordered[index].x - (previous.x + previous.width);
                // Spaces inside a phrase are ~0.3 × text height; gaps between menu items are larger (≈1.1–1.4 ×), so a single word run is cut there.
                if (gap > Math.max(24, ordered[index].height * 1.0)) segments.push([]);
                segments[segments.length - 1].push(ordered[index]);
            }
            segments.forEach(function (segment) {
                var x = Math.min.apply(null, segment.map(function (word) { return word.x; }));
                var y = Math.min.apply(null, segment.map(function (word) { return word.y; }));
                var right = Math.max.apply(null, segment.map(function (word) { return word.x + word.width; }));
                var bottom = Math.max.apply(null, segment.map(function (word) { return word.y + word.height; }));
                lines.push({ x: x, y: y, width: right - x, height: bottom - y, words: segment });
            });
        });
        return lines.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    }

    function rowColor(data, width, y, fromX, toX) {
        var reds = [];
        var greens = [];
        var blues = [];
        for (var x = fromX; x < toX; x += 1) {
            var offset = (y * width + x) * 4;
            reds.push(data[offset]);
            greens.push(data[offset + 1]);
            blues.push(data[offset + 2]);
        }
        var mid = function (values) { return values.sort(function (a, b) { return a - b; })[Math.floor(values.length / 2)]; };
        return [mid(reds), mid(greens), mid(blues)];
    }

    function colorGap(first, second) {
        return Math.abs(first[0] - second[0]) + Math.abs(first[1] - second[1]) + Math.abs(first[2] - second[2]);
    }

    // Sections: runs of one margin colour (the page edge shows each section's own background), then split at wide empty gaps.
    // Every size is relative to the page width, so tall screenshots behave like short ones.
    function detectBands(data, width, height) {
        var edge = Math.max(3, Math.round(width * .012));
        var runs = [];
        var current = null;
        var pending = 0;
        for (var y = 0; y < height; y += 1) {
            var color = rowColor(data, width, y, 1, 1 + edge);
            if (!current) {
                current = { y: 0, color: color };
                continue;
            }
            if (colorGap(color, current.color) > 14) {
                pending += 1;
                if (pending >= 6) {
                    var start = y - pending + 1;
                    runs.push({ y: current.y, height: start - current.y, color: current.color });
                    current = { y: start, color: color };
                    pending = 0;
                }
            } else {
                pending = 0;
            }
        }
        if (current) runs.push({ y: current.y, height: height - current.y, color: current.color });
        var minGap = Math.max(48, Math.round(width * .058));
        var bands = [];
        runs.forEach(function (run) {
            var empty = 0;
            var emptyStart = run.y;
            var splitAt = [];
            for (var row = run.y; row < run.y + run.height; row += 1) {
                var blank = true;
                for (var x = 0; x < width; x += 3) {
                    var offset = (row * width + x) * 4;
                    if (Math.abs(data[offset] - run.color[0]) + Math.abs(data[offset + 1] - run.color[1]) + Math.abs(data[offset + 2] - run.color[2]) > 12) {
                        blank = false;
                        break;
                    }
                }
                if (blank) {
                    if (!empty) emptyStart = row;
                    empty += 1;
                } else {
                    if (empty >= minGap && emptyStart > run.y) splitAt.push(Math.round(emptyStart + empty / 2));
                    empty = 0;
                }
            }
            var from = run.y;
            splitAt.concat([run.y + run.height]).forEach(function (to) {
                if (to - from > 0) bands.push({ y: from, height: to - from, background: hex(run.color) });
                from = to;
            });
        });
        // Slivers (padding, borders) join a neighbouring band with the same background.
        var sliver = Math.max(24, Math.round(width * .05));
        var sameBackground = function (a, b) {
            return a && b && colorGap([parseInt(a.background.slice(1, 3), 16), parseInt(a.background.slice(3, 5), 16), parseInt(a.background.slice(5, 7), 16)],
                [parseInt(b.background.slice(1, 3), 16), parseInt(b.background.slice(3, 5), 16), parseInt(b.background.slice(5, 7), 16)]) <= 14;
        };
        var merged = [];
        bands.forEach(function (band, index) {
            var previous = merged[merged.length - 1];
            var next = bands[index + 1];
            if (band.height < sliver && previous && sameBackground(previous, band)) {
                previous.height = band.y + band.height - previous.y;
            } else if (previous && previous.height < sliver && sameBackground(previous, band)) {
                previous.height += band.height;
            } else if (band.height < sliver && !previous && next && sameBackground(band, next)) {
                next.y = band.y;
                next.height += band.height;
            } else {
                merged.push({ y: band.y, height: band.height, background: band.background });
            }
        });
        return merged;
    }

    // ---- OCR input preparation -------------------------------------------------------------------------------------------
    // Works on decoded RGBA pixels only, so it behaves the same for PNG, JPEG, WebP, screenshots or exports.

    // Semi-transparent pixels are composited onto a colour that keeps text visible (dark under light content, white otherwise).
    function flattenAlpha(data) {
        var transparent = false;
        var lightSum = 0;
        var opaque = 0;
        for (var index = 0; index < data.length; index += 4) {
            if (data[index + 3] < 255) transparent = true;
            if (data[index + 3] > 200) {
                lightSum += data[index] * .299 + data[index + 1] * .587 + data[index + 2] * .114;
                opaque += 1;
            }
        }
        if (!transparent) return data;
        var base = opaque && lightSum / opaque > 190 ? [17, 24, 39] : [255, 255, 255];
        var out = new Uint8ClampedArray(data.length);
        for (var offset = 0; offset < data.length; offset += 4) {
            var alpha = data[offset + 3] / 255;
            out[offset] = data[offset] * alpha + base[0] * (1 - alpha);
            out[offset + 1] = data[offset + 1] * alpha + base[1] * (1 - alpha);
            out[offset + 2] = data[offset + 2] * alpha + base[2] * (1 - alpha);
            out[offset + 3] = 255;
        }
        return out;
    }

    // Typical height (px) of an ink line, from rows that contain vertical strokes. Horizontal borders do not count,
    // and neither do columns that are an edge on nearly every row (a screenshot frame or a vertical rule).
    function estimateTextHeight(data, width, height) {
        var luma = new Float32Array(width * height);
        for (var pixel = 0; pixel < luma.length; pixel += 1) {
            luma[pixel] = data[pixel * 4] * .299 + data[pixel * 4 + 1] * .587 + data[pixel * 4 + 2] * .114;
        }
        var edge = new Uint8Array(width * height);
        var columnEdges = new Uint32Array(width);
        for (var row = 0; row < height; row += 1) {
            for (var column = 1; column < width; column += 1) {
                if (Math.abs(luma[row * width + column] - luma[row * width + column - 1]) > 40) {
                    edge[row * width + column] = 1;
                    columnEdges[column] += 1;
                }
            }
        }
        var ruled = new Uint8Array(width);
        for (var check = 0; check < width; check += 1) {
            if (columnEdges[check] > height * .85) {
                ruled[check] = 1;
                if (check + 1 < width) ruled[check + 1] = 1;
            }
        }
        var minEdges = Math.max(3, Math.round(width * .004));
        var heights = [];
        var run = 0;
        var gap = 0;
        for (var y = 0; y <= height; y += 1) {
            var edges = 0;
            if (y < height) {
                for (var x = 1; x < width; x += 1) {
                    if (edge[y * width + x] && !ruled[x]) edges += 1;
                }
            }
            if (edges >= minEdges) {
                run += gap + 1;
                gap = 0;
            } else if (run) {
                gap += 1;
                if (gap > 2 || y === height) {
                    if (run >= 5 && run <= 120) heights.push(run);
                    run = 0;
                    gap = 0;
                }
            }
        }
        if (!heights.length) return 0;
        heights.sort(function (a, b) { return a - b; });
        return heights[Math.floor(heights.length / 2)];
    }

    // Upscale only when text is below what the OCR engine reads reliably; never more than needed, never beyond the pixel budget.
    function chooseOcrScale(textHeight, width, height, options) {
        var target = options && options.target || 40;
        var comfortable = options && options.comfortable || 30;
        var maxPixels = options && options.maxPixels || 16000000;
        if (!textHeight || textHeight >= comfortable) return 1;
        var scale = Math.min(4, target / textHeight);
        scale = Math.min(scale, Math.sqrt(maxPixels / Math.max(1, width * height)));
        return scale < 1.15 ? 1 : Math.floor(scale * 4) / 4;
    }

    function lanczos(value, support) {
        if (value === 0) return 1;
        if (value <= -support || value >= support) return 0;
        var scaled = Math.PI * value;
        return support * Math.sin(scaled) * Math.sin(scaled / support) / (scaled * scaled);
    }

    function axisWeights(sourceSize, targetSize, support) {
        var ratio = sourceSize / targetSize;
        var filterScale = Math.max(1, ratio);
        var radius = support * filterScale;
        var starts = new Int32Array(targetSize);
        var counts = new Int32Array(targetSize);
        var weights = [];
        for (var index = 0; index < targetSize; index += 1) {
            var center = (index + .5) * ratio - .5;
            var first = Math.max(0, Math.floor(center - radius + 1));
            var last = Math.min(sourceSize - 1, Math.floor(center + radius));
            var list = [];
            var sum = 0;
            for (var tap = first; tap <= last; tap += 1) {
                var weight = lanczos((tap - center) / filterScale, support);
                list.push(weight);
                sum += weight;
            }
            starts[index] = first;
            counts[index] = list.length;
            weights.push(list.map(function (weight) { return sum ? weight / sum : 0; }));
        }
        return { starts: starts, counts: counts, weights: weights };
    }

    // Separable Lanczos-3 resampling of RGBA data (up or down).
    function resampleLanczos(data, width, height, targetWidth, targetHeight) {
        var horizontal = axisWeights(width, targetWidth, 3);
        var vertical = axisWeights(height, targetHeight, 3);
        var middle = new Float32Array(targetWidth * height * 3);
        for (var y = 0; y < height; y += 1) {
            for (var x = 0; x < targetWidth; x += 1) {
                var red = 0, green = 0, blue = 0;
                var start = horizontal.starts[x];
                var list = horizontal.weights[x];
                for (var tap = 0; tap < list.length; tap += 1) {
                    var offset = (y * width + start + tap) * 4;
                    red += data[offset] * list[tap];
                    green += data[offset + 1] * list[tap];
                    blue += data[offset + 2] * list[tap];
                }
                var target = (y * targetWidth + x) * 3;
                middle[target] = red;
                middle[target + 1] = green;
                middle[target + 2] = blue;
            }
        }
        var out = new Uint8ClampedArray(targetWidth * targetHeight * 4);
        for (var row = 0; row < targetHeight; row += 1) {
            var rowStart = vertical.starts[row];
            var rowWeights = vertical.weights[row];
            for (var column = 0; column < targetWidth; column += 1) {
                var r = 0, g = 0, b = 0;
                for (var step = 0; step < rowWeights.length; step += 1) {
                    var source = ((rowStart + step) * targetWidth + column) * 3;
                    r += middle[source] * rowWeights[step];
                    g += middle[source + 1] * rowWeights[step];
                    b += middle[source + 2] * rowWeights[step];
                }
                var destination = (row * targetWidth + column) * 4;
                out[destination] = r;
                out[destination + 1] = g;
                out[destination + 2] = b;
                out[destination + 3] = 255;
            }
        }
        return out;
    }

    // Unsharp mask on luminance, with a threshold so flat areas and compression noise are not amplified.
    function sharpen(data, width, height, amount, sigma, threshold) {
        var radius = Math.max(1, Math.ceil(sigma * 3));
        var kernel = [];
        var total = 0;
        for (var tap = -radius; tap <= radius; tap += 1) {
            var weight = Math.exp(-(tap * tap) / (2 * sigma * sigma));
            kernel.push(weight);
            total += weight;
        }
        kernel = kernel.map(function (weight) { return weight / total; });
        var luma = new Float32Array(width * height);
        for (var pixel = 0; pixel < luma.length; pixel += 1) {
            luma[pixel] = data[pixel * 4] * .299 + data[pixel * 4 + 1] * .587 + data[pixel * 4 + 2] * .114;
        }
        var pass = new Float32Array(luma.length);
        for (var y = 0; y < height; y += 1) {
            for (var x = 0; x < width; x += 1) {
                var sum = 0;
                for (var k = -radius; k <= radius; k += 1) {
                    sum += luma[y * width + Math.min(width - 1, Math.max(0, x + k))] * kernel[k + radius];
                }
                pass[y * width + x] = sum;
            }
        }
        var out = new Uint8ClampedArray(data);
        for (var row = 0; row < height; row += 1) {
            for (var column = 0; column < width; column += 1) {
                var blurred = 0;
                for (var s = -radius; s <= radius; s += 1) {
                    blurred += pass[Math.min(height - 1, Math.max(0, row + s)) * width + column] * kernel[s + radius];
                }
                var index = row * width + column;
                var difference = luma[index] - blurred;
                if (Math.abs(difference) <= threshold) continue;
                var delta = difference * amount;
                out[index * 4] += delta;
                out[index * 4 + 1] += delta;
                out[index * 4 + 2] += delta;
            }
        }
        return out;
    }

    function prepareForOcr(data, width, height, options) {
        var settings = options || {};
        var flat = flattenAlpha(data);
        var textHeight = estimateTextHeight(flat, width, height);
        var scale = settings.scale || chooseOcrScale(textHeight, width, height, settings);
        if (scale <= 1) {
            return { data: flat, width: width, height: height, scale: 1, textHeight: textHeight };
        }
        var targetWidth = Math.round(width * scale);
        var targetHeight = Math.round(height * scale);
        var scaled = resampleLanczos(flat, width, height, targetWidth, targetHeight);
        if (settings.sharpen !== false) {
            scaled = sharpen(scaled, targetWidth, targetHeight, settings.amount || .6, Math.max(.8, scale * .45), 3);
        }
        return { data: scaled, width: targetWidth, height: targetHeight, scale: targetWidth / width, textHeight: textHeight };
    }

    // Serif or sans, read from the glyphs of one text line. Serif faces have thick vertical stems and thin horizontal strokes
    // (serifs, crossbars), sans faces draw both at about the same weight. The ratio of the median stem width to the median
    // thickness of the short vertical runs tells them apart. Returns null when the line is too small or too sparse to judge.
    function classifyTypeface(data, width, box, bold) {
        var x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
        var w = Math.min(width - x0, Math.ceil(box.width)), h = Math.min(Math.floor(data.length / 4 / width) - y0, Math.ceil(box.height));
        if (w < 20 || h < 10) return null;
        var counts = {}, best = 0, bgKey = 0;
        for (var y = 0; y < h; y += 1) {
            for (var x = 0; x < w; x += 1) {
                var o = ((y0 + y) * width + x0 + x) * 4;
                var key = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
                var n = (counts[key] || 0) + 1;
                counts[key] = n;
                if (n > best) { best = n; bgKey = key; }
            }
        }
        var br = ((bgKey >> 10) << 3) + 4, bg = (((bgKey >> 5) & 31) << 3) + 4, bb = ((bgKey & 31) << 3) + 4;
        var cover = new Float32Array(w * h);
        var peak = 0;
        for (var i = 0; i < w * h; i += 1) {
            var q = ((y0 + Math.floor(i / w)) * width + x0 + (i % w)) * 4;
            var d = Math.abs(data[q] - br) + Math.abs(data[q + 1] - bg) + Math.abs(data[q + 2] - bb);
            cover[i] = d;
            if (d > peak) peak = d;
        }
        if (peak < 120) return null;
        for (var j = 0; j < cover.length; j += 1) cover[j] = Math.min(1, cover[j] / peak);
        var rowInk = new Float32Array(h);
        for (var ry = 0; ry < h; ry += 1) for (var rx = 0; rx < w; rx += 1) rowInk[ry] += cover[ry * w + rx];
        var maxRow = Math.max.apply(null, Array.prototype.slice.call(rowInk));
        var top = 0, bottom = h - 1;
        while (top < h && rowInk[top] < maxRow * .12) top += 1;
        while (bottom > top && rowInk[bottom] < maxRow * .12) bottom -= 1;
        var glyphHeight = bottom - top + 1;
        if (glyphHeight < 10) return null;
        // Rows of the x-height band (clear of ascenders, descenders and rounded overshoot) carry the stems.
        var bandTop = top + Math.round(glyphHeight * .38), bandBottom = top + Math.round(glyphHeight * .72);
        var stems = [];
        for (var sy = bandTop; sy <= bandBottom; sy += 1) {
            var run = 0;
            for (var sx = 0; sx <= w; sx += 1) {
                var value = sx < w ? cover[sy * w + sx] : 0;
                if (value > .12) run += value;
                else if (run) { stems.push(run); run = 0; }
            }
        }
        var shorts = [];
        var shortLimit = glyphHeight * .3;
        for (var cx = 0; cx < w; cx += 1) {
            var length = 0, runLength = 0;
            for (var cy = top; cy <= bottom + 1; cy += 1) {
                var v = cy <= bottom ? cover[cy * w + cx] : 0;
                if (v > .12) { length += v; runLength += 1; }
                else if (runLength) { if (runLength <= shortLimit) shorts.push(length); length = 0; runLength = 0; }
            }
        }
        if (stems.length < 12 || shorts.length < 12) return null;
        var median = function (list) { var sorted = list.slice().sort(function (a, b) { return a - b; }); return sorted[Math.floor(sorted.length / 2)]; };
        var ratio = median(stems) / Math.max(.2, median(shorts));
        // Heavy strokes thicken the horizontals too, so bold text needs a higher ratio (and bigger glyphs) to count as serif.
        if (bold && glyphHeight < 14) return null;
        return { serif: ratio >= (bold ? 2.1 : 1.52), ratio: ratio };
    }

    // A linear gradient behind a box (a section band or a card), or null. The box is read as a grid of cells, each reduced to its
    // median colour so text and icons drop out; for each direction the cells are ordered along it and the colour must change
    // smoothly (and clearly) from one end to the other. Photos, noise and radial or mesh gradients fit no direction and give null.
    // Angles are CSS angles (90 = to the right, 180 = to the bottom); stops are the end colours, plus a middle one when the
    // ramp is visibly not a straight mix of the ends.
    function detectLinearGradient(data, width, height, box) {
        var bw = Math.min(Math.floor(box.width), width - Math.max(0, Math.floor(box.x)));
        var bh = Math.min(Math.floor(box.height), height - Math.max(0, Math.floor(box.y)));
        if (bw < 160 || bh < 40) return null;
        var x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
        var cols = Math.min(14, Math.max(4, Math.floor(bw / 24)));
        var rows = Math.min(14, Math.max(3, Math.floor(bh / 24)));
        var cells = [];
        for (var gy = 0; gy < rows; gy += 1) {
            for (var gx = 0; gx < cols; gx += 1) {
                var cx0 = x0 + Math.floor(gx * bw / cols), cx1 = x0 + Math.floor((gx + 1) * bw / cols);
                var cy0 = y0 + Math.floor(gy * bh / rows), cy1 = y0 + Math.floor((gy + 1) * bh / rows);
                var rs = [], gs = [], bs = [];
                var step = Math.max(1, Math.floor(Math.min(cx1 - cx0, cy1 - cy0) / 6));
                for (var y = cy0; y < cy1; y += step) {
                    for (var x = cx0; x < cx1; x += step) {
                        var o = (y * width + x) * 4;
                        rs.push(data[o]); gs.push(data[o + 1]); bs.push(data[o + 2]);
                    }
                }
                if (!rs.length) return null;
                var med = function (list) { list.sort(function (a, b) { return a - b; }); return list[Math.floor(list.length / 2)]; };
                cells.push({ gx: (gx + .5) / cols, gy: (gy + .5) / rows, c: [med(rs), med(gs), med(bs)] });
            }
        }
        var distance = function (a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); };
        var mean = function (list) { var n = Math.max(1, list.length); return [0, 1, 2].map(function (i) { return list.reduce(function (sum, c) { return sum + c[i]; }, 0) / n; }); };
        var flat = mean(cells.map(function (cell) { return cell.c; }));
        var flatError = cells.reduce(function (sum, cell) { return sum + distance(cell.c, flat); }, 0) / cells.length;
        if (flatError < 10) return null;
        var best = null;
        // Opposite directions fit equally well (with the colours swapped); the first angle listed wins such a tie.
        var angles = [180, 90, 135, 45, 0, 270, 225, 315];
        for (var extra = 15; extra < 360; extra += 15) if (angles.indexOf(extra) === -1) angles.push(extra);
        angles.forEach(function (angle) {
            var rad = angle * Math.PI / 180;
            var dx = Math.sin(rad), dy = -Math.cos(rad);
            var projected = cells.map(function (cell) { return { t: (cell.gx - .5) * dx * bw + (cell.gy - .5) * dy * bh, c: cell.c }; });
            var low = Math.min.apply(null, projected.map(function (p) { return p.t; }));
            var high = Math.max.apply(null, projected.map(function (p) { return p.t; }));
            if (high - low < 1) return;
            var bins = [[], [], [], [], []];
            projected.forEach(function (p) { p.u = (p.t - low) / (high - low); bins[Math.min(4, Math.floor(p.u * 5))].push(p.c); });
            if (bins.some(function (bin) { return !bin.length; })) return;
            // Medians (not means) per bin, and a trimmed error below, so large letters or an image sitting in the area do not decide the fit.
            var colors = bins.map(function (bin) {
                return [0, 1, 2].map(function (k) { var v = bin.map(function (c) { return c[k]; }).sort(function (a, b) { return a - b; }); return v[Math.floor(v.length / 2)]; });
            });
            var strength = distance(colors[0], colors[4]);
            if (strength < 40) return;
            // A step (two flat areas meeting at an edge, as at a sidebar) is not a ramp: no single interval may carry most of the change.
            var steps = [0, 1, 2, 3].map(function (i) { return distance(colors[i], colors[i + 1]); });
            if (Math.max.apply(null, steps) > strength * .55 || Math.min.apply(null, steps) < strength * .06) return;
            var residuals = projected.map(function (p) {
                var pos = Math.min(3.999, Math.max(0, p.u * 5 - .5));
                var i = Math.floor(pos), f = pos - i;
                var fit = [0, 1, 2].map(function (k) { return colors[i][k] * (1 - f) + colors[i + 1][k] * f; });
                return distance(p.c, fit);
            }).sort(function (a, b) { return a - b; });
            var kept = residuals.slice(0, Math.max(1, Math.floor(residuals.length * .75)));
            var error = kept.reduce(function (sum, v) { return sum + v; }, 0) / kept.length;
            if (!best || error < best.error - .01) best = { angle: angle, error: error, colors: colors, strength: strength };
        });
        // The ramp has to explain most of the colour variation and leave little behind.
        if (!best || best.error > 14 || best.error > flatError * .4) return null;
        var hex = function (c) { return '#' + c.map(function (v) { var n = Math.max(0, Math.min(255, Math.round(v))); return (n < 16 ? '0' : '') + n.toString(16); }).join(''); };
        // Bin centres sit at .1 and .9 of the ramp, so the ends are extrapolated to 0 and 1.
        var start = best.colors[0].map(function (v, i) { return v - (best.colors[1][i] - v) * .5; });
        var end = best.colors[4].map(function (v, i) { return v + (v - best.colors[3][i]) * .5; });
        var stops = [{ pos: 0, color: hex(start) }];
        var straight = [0, 1, 2].map(function (k) { return (start[k] + end[k]) / 2; });
        if (distance(best.colors[2], straight) > 14) stops.push({ pos: 50, color: hex(best.colors[2]) });
        stops.push({ pos: 100, color: hex(end) });
        return { type: 'linear', angle: best.angle, stops: stops };
    }

    // A soft backdrop (mesh or radial gradient, blurred glow) no linear ramp can describe. The area is read as a coarse grid of
    // median colours; cells under text or pictures (`mask` rects) are filled in from their neighbours, so the result is the
    // background with the foreground removed. Returns null for flat areas, photos and anything with hard edges.
    // `strict` additionally demands that there is no edge at all (used to decide whether neighbouring bands are one backdrop).
    // `minKnown` is the share of cells that must be free of foreground (.45 by default; lower for a box that is mostly text);
    // `minSpread` is the colour variation below which the area counts as flat (24 by default; 0 asks only whether it is smooth);
    // `maxForeground` is the share of cells that may stand out from their neighbours, as unrecognised text does (.12 by default).
        function detectBackdrop(data, width, height, box, mask, strict, minKnown, minSpread, maxForeground) {
        var x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
        var bw = Math.min(Math.floor(box.width), width - x0), bh = Math.min(Math.floor(box.height), height - y0);
        if (bw < 160 || bh < 80) return null;
        var size = Math.max(12, Math.ceil(Math.max(bw, bh) / 96));
        var cols = Math.ceil(bw / size), rows = Math.ceil(bh / size);
        var masked = new Uint8Array(cols * rows);
        (mask || []).forEach(function (rect) {
            var c0 = Math.floor((rect.x - x0) / size), c1 = Math.floor((rect.x + rect.width - x0) / size);
            var r0 = Math.floor((rect.y - y0) / size), r1 = Math.floor((rect.y + rect.height - y0) / size);
            for (var r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r += 1) for (var c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c += 1) masked[r * cols + c] = 1;
        });
        var cells = new Array(cols * rows);
        var med = function (list) { list.sort(function (a, b) { return a - b; }); return list[Math.floor(list.length / 2)]; };
        for (var gy = 0; gy < rows; gy += 1) {
            for (var gx = 0; gx < cols; gx += 1) {
                var rs = [], gs = [], bs = [];
                var cx1 = Math.min(bw, (gx + 1) * size), cy1 = Math.min(bh, (gy + 1) * size);
                var step = Math.max(1, Math.floor(size / 5));
                for (var y = gy * size; y < cy1; y += step) {
                    for (var x = gx * size; x < cx1; x += step) {
                        var o = ((y0 + y) * width + x0 + x) * 4;
                        rs.push(data[o]); gs.push(data[o + 1]); bs.push(data[o + 2]);
                    }
                }
                cells[gy * cols + gx] = rs.length ? [med(rs), med(gs), med(bs)] : null;
            }
        }
        var at = function (c, r) { return c < 0 || r < 0 || c >= cols || r >= rows ? null : cells[r * cols + c]; };
        var known = function (c, r) { return !masked[r * cols + c] && cells[r * cols + c] ? cells[r * cols + c] : null; };
        var dist = function (a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); };
        var knownCount = 0;
        for (var i = 0; i < masked.length; i += 1) if (!masked[i] && cells[i]) knownCount += 1;
        if (knownCount < cells.length * (minKnown || .45)) return null;
        // Cells that stand out from their neighbours (letters OCR missed) are foreground too; too many of them means a picture, not a backdrop.
        var before = 0;
        for (var k = 0; k < masked.length; k += 1) if (masked[k]) before += 1;
        for (var pass = 0; pass < 2; pass += 1) {
            for (var rr = 0; rr < rows; rr += 1) {
                for (var cc = 0; cc < cols; cc += 1) {
                    var cell = known(cc, rr);
                    if (!cell) continue;
                    var around = [];
                    for (var dy = -1; dy <= 1; dy += 1) for (var dx = -1; dx <= 1; dx += 1) {
                        if ((dx || dy) && cc + dx >= 0 && rr + dy >= 0 && cc + dx < cols && rr + dy < rows && known(cc + dx, rr + dy)) around.push(known(cc + dx, rr + dy));
                    }
                    if (around.length < 3) continue;
                    var m = [0, 1, 2].map(function (k) { return med(around.map(function (a) { return a[k]; })); });
                    if (dist(cell, m) > 40) masked[rr * cols + cc] = 1;
                }
            }
        }
        var removed = 0;
        for (var q = 0; q < masked.length; q += 1) if (masked[q]) removed += 1;
        if (removed - before > knownCount * (maxForeground || .12)) return null;

        // Neighbouring known cells: how often does the colour jump, and how far does it drift on average.
        var pairs = 0, jumps = 0, drift = 0;
        var diffs = [];
        for (var r = 0; r < rows; r += 1) {
            for (var c = 0; c < cols; c += 1) {
                var here = known(c, r);
                if (!here) continue;
                [[1, 0], [0, 1]].forEach(function (d) {
                    if (c + d[0] >= cols || r + d[1] >= rows) return;
                    var next = known(c + d[0], r + d[1]);
                    if (!next) return;
                    var delta = dist(here, next);
                    pairs += 1; drift += delta; diffs.push(delta);
                    if (delta > 45) jumps += 1;
                });
            }
        }
        if (pairs < 20) return null;
        // A few jumps are allowed even in a small area (one edge row of cells is a lot of pairs out of a few hundred).
        var allowedJumps = strict ? .003 * pairs : Math.max(2, .004 * pairs);
        if (jumps > allowedJumps || drift / pairs > 9) return null;
        // Fill the masked cells outward from the known ones.
        var filled = cells.map(function (cell, index) { return masked[index] ? null : cell; });
        var remaining = filled.filter(function (cell) { return !cell; }).length;
        for (var guard = 0; remaining && guard < cols + rows; guard += 1) {
            var next = filled.slice();
            for (var fr = 0; fr < rows; fr += 1) {
                for (var fc = 0; fc < cols; fc += 1) {
                    if (filled[fr * cols + fc]) continue;
                    var sum = [0, 0, 0], count = 0;
                    for (var ey = -1; ey <= 1; ey += 1) for (var ex = -1; ex <= 1; ex += 1) {
                        var nb = (ex || ey) && fc + ex >= 0 && fr + ey >= 0 && fc + ex < cols && fr + ey < rows ? filled[(fr + ey) * cols + fc + ex] : null;
                        if (nb) { sum[0] += nb[0]; sum[1] += nb[1]; sum[2] += nb[2]; count += 1; }
                    }
                    if (count) { next[fr * cols + fc] = [sum[0] / count, sum[1] / count, sum[2] / count]; remaining -= 1; }
                }
            }
            filled = next;
        }
        if (remaining) return null;
        var mean = [0, 1, 2].map(function (k) { return filled.reduce(function (sum, cell) { return sum + cell[k]; }, 0) / filled.length; });
        var spread = filled.reduce(function (sum, cell) { return sum + dist(cell, mean); }, 0) / filled.length;
        // Flat areas are an ordinary background colour, not a backdrop image.
        if (spread < (minSpread === undefined ? 24 : minSpread)) return null;
        var pixels = [];
        filled.forEach(function (cell) { pixels.push(Math.round(cell[0]), Math.round(cell[1]), Math.round(cell[2])); });
        return { cols: cols, rows: rows, cell: size, spread: spread, jumps: jumps, pairs: pairs, drift: drift / pairs, pixels: pixels };
    }

    // A trailing asterisk marks a required field; it becomes a flag and leaves the label (or placeholder) it was typed in.
    function splitRequiredMark(label, placeholder) {
        var mark = /\s*[*\u2217\uFF0A\u2731]+\s*$/;
        label = label || '';
        placeholder = placeholder || '';
        if (mark.test(label)) return { label: label.replace(mark, '').trim(), placeholder: placeholder, required: true };
        if (mark.test(placeholder)) return { label: label, placeholder: placeholder.replace(mark, '').trim(), required: true };
        return { label: label, placeholder: placeholder, required: false };
    }

    // Several OCR passes over the same image: keep the most confident reading wherever passes found the same word.
    function mergeWordPasses(passes) {
        var all = [];
        passes.forEach(function (words) { (words || []).forEach(function (word) { all.push(word); }); });
        all.sort(function (a, b) { return (b.confidence || 0) - (a.confidence || 0); });
        var kept = [];
        all.forEach(function (word) {
            var overlaps = kept.some(function (other) {
                var left = Math.max(word.x, other.x);
                var top = Math.max(word.y, other.y);
                var right = Math.min(word.x + word.width, other.x + other.width);
                var bottom = Math.min(word.y + word.height, other.y + other.height);
                if (right <= left || bottom <= top) return false;
                var shared = (right - left) * (bottom - top);
                var smaller = Math.min(word.width * word.height, other.width * other.height);
                return shared / Math.max(1, smaller) > .5;
            });
            if (!overlaps) kept.push(word);
        });
        return kept.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    }

    // Advice for the user, judged from the screenshot width and the median height of the recognised words.
    // Returns an empty list when the input is fine.
    function assessResolution(width, words) {
        var advice = [];
        var heights = (words || []).map(function (word) { return word.height; }).filter(function (value) { return value > 0; }).sort(function (a, b) { return a - b; });
        var median = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
        if (width < 900) advice.push('Скріншот вузький (' + width + ' px): дрібні елементи можуть не розпізнатися. Зніміть сторінку ширше, бажано від 1280 px.');
        if (median && median < 9) advice.push('Текст дуже дрібний (медіанна висота слова ' + median + ' px): збільште масштаб сторінки в браузері або зробіть скріншот у 2x.');
        if (width > 4000) advice.push('Скріншот дуже великий (' + width + ' px): аналіз буде повільним, достатньо 1440–2000 px.');
        if (!heights.length) advice.push('Текст на скріншоті не розпізнано: перевірте, що це не порожнє або розмите зображення.');
        return advice;
    }

    return {
        assessResolution: assessResolution,
        detectBackdrop: detectBackdrop,
        splitRequiredMark: splitRequiredMark,
        detectOutline: detectOutline,
        detectIconBlobs: detectIconBlobs,
        findIcons: findIcons,
        isColourful: isColourful,
        isRuleWord: isRuleWord,
        detectPhotoRegions: detectPhotoRegions,
        detectSurfaces: detectSurfaces,
        classifySurfaces: classifySurfaces,
        detectLineRuns: detectLineRuns,
        dominantShare: dominantShare,
        isPhotographic: isPhotographic,
        groupWordsIntoLines: groupWordsIntoLines,
        detectBands: detectBands,
        flattenAlpha: flattenAlpha,
        estimateTextHeight: estimateTextHeight,
        chooseOcrScale: chooseOcrScale,
        resampleLanczos: resampleLanczos,
        sharpen: sharpen,
        prepareForOcr: prepareForOcr,
        classifyTypeface: classifyTypeface,
        detectLinearGradient: detectLinearGradient,
        mergeWordPasses: mergeWordPasses
    };
}));
