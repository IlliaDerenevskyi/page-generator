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
            return {
                x: region.x, y: region.y, width: region.width, height: region.height,
                fill: region.color, background: hex(region.color), rounded: rounded ? 6 : 0,
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
        for (var x = surface.x; x < surface.x + surface.width; x += step) {
            sample(x, surface.y - gap);
            sample(x, surface.y + surface.height + gap - 1);
        }
        for (var y = surface.y; y < surface.y + surface.height; y += step) {
            sample(surface.x - gap, y);
            sample(surface.x + surface.width + gap - 1, y);
        }
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
        return samples.filter(function (color) {
            return Math.abs(color[0] - fill[0]) + Math.abs(color[1] - fill[1]) + Math.abs(color[2] - fill[2]) <= 36;
        }).length / samples.length;
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
            if (around < .6) return;
            if (surface.height >= unit * 1.1 && surface.height <= unit * 4.2 && surface.width <= unit * 22 && ratio >= 1.8 &&
                contrast >= 12 && surface.rounded && surface.width * surface.height <= unit * unit * 70) {
                surface.kind = 'badge';
            } else if (surface.height >= unit * 2.3 && surface.height <= unit * 9 && surface.width >= unit * 6 && ratio >= 1.8 &&
                contrast >= 70 && saturation(surface.fill) >= 60) {
                surface.kind = 'button';
            } else if (surface.height >= unit * 2.5 && surface.height <= unit * 24 && surface.width >= unit * 12 && ratio >= 3 &&
                contrast >= 3 && contrast < 60 && parent && luminance(parentFill) >= 230) {
                surface.kind = 'input-candidate';
            } else if (surface.height >= unit * 5 && surface.width >= unit * 25 && luminance(surface.fill) >= 235 && colorStep >= 9) {
                surface.kind = 'card';
            }
        });
        // An input is only trusted when similar fields repeat in one column.
        surfaces.forEach(function (surface) {
            if (surface.kind !== 'input-candidate') return;
            var siblings = surfaces.filter(function (other) {
                return other !== surface && other.kind === 'input-candidate' && other.parent === surface.parent &&
                    Math.abs(other.x - surface.x) <= unit && Math.abs(other.width - surface.width) <= unit;
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

    return {
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
        mergeWordPasses: mergeWordPasses
    };
}));
